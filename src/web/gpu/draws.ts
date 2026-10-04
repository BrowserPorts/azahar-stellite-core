// SPDX-License-Identifier: GPL-2.0-or-later

import type { NativeDraw, NativeDrawState } from "./draw-types";
import { PicaShaders } from "./pica-shaders";
import { GraphicsSamplers } from "./samplers";
import { ShadowPixels } from "./shadow-pixels";
import { GraphicsTextures } from "./textures";

const compares: readonly GPUCompareFunction[] = ["never", "always", "equal", "not-equal", "less", "less-equal", "greater", "greater-equal"];
const stencilOps: readonly GPUStencilOperation[] = ["keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
const factors: readonly GPUBlendFactor[] = ["zero", "one", "src", "one-minus-src", "dst", "one-minus-dst", "src-alpha", "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "constant", "one-minus-constant", "constant", "one-minus-constant", "src-alpha-saturated"];
const equations: readonly GPUBlendOperation[] = ["add", "subtract", "reverse-subtract"];

interface ResourceBindingGroup {
  resources: readonly (GPUBuffer | GPUTextureView | GPUSampler)[];
  group: GPUBindGroup;
}

interface DrawUpload {
  buffer: GPUBuffer;
  bytes: Uint8Array<ArrayBuffer>;
}

interface DrawPass {
  encoder: GPURenderPassEncoder;
  color: GPUTextureView | undefined;
  depth: GPUTextureView | undefined;
}

interface DrawPipeline {
  pipeline: GPURenderPipeline;
  groups: readonly GPUBindGroupLayout[];
  textures: ResourceBindingGroup[];
  uniforms: WeakMap<GPUBuffer, GPUBindGroup>;
  utilities: WeakMap<GPUBuffer, ResourceBindingGroup[]>;
}

const pipelineStateKeys = ["cull", "flipped", "colorMask", "depthWrite", "depthCompare", "stencil",
  "stencilCompare", "stencilFail", "stencilDepthFail", "stencilPass", "stencilReadMask", "stencilWriteMask",
  "blend", "rgbEquation", "alphaEquation", "rgbSource", "rgbDest", "alphaSource", "alphaDest", "logicOp",
  "texture0Type"] as const satisfies readonly (keyof NativeDrawState)[];

interface PipelineSelection {
  configuration: Uint8Array<ArrayBuffer>;
  state: NativeDrawState;
  colorFormat: number;
  color: GPUTextureFormat | undefined;
  depth: GPUTextureFormat | undefined;
  pipeline: Promise<DrawPipeline>;
}

/** Executes native PICA triangle batches, retaining the upstream fragment generator. */
export class GraphicsDraws {
  #pipelines = new Map<string, Promise<DrawPipeline>>();
  #lastPipeline: PipelineSelection | undefined;
  // Views follow texture lifetimes across native handle reuse and save-state restoration.
  #views = new WeakMap<GPUTexture, Map<number | GPUTextureViewDimension | undefined, GPUTextureView>>();
  #encoder: GPUCommandEncoder | undefined;
  #pass: DrawPass | undefined;
  #temporary: (GPUTexture | GPUBuffer)[] = [];
  #drawCount = 0;
  #uploadBytes = 0;
  #upload: DrawUpload | undefined;
  #uniformOffsets = new Uint32Array(4);
  #luts: readonly GPUBuffer[];
  #empty: GPUTexture;
  #emptyShadow: GPUBuffer;
  #utilitySampler: GPUSampler;
  #closed = false;

  private constructor(readonly device: GPUDevice, private readonly shaders: PicaShaders,
    private readonly textures: GraphicsTextures, private readonly samplers: GraphicsSamplers,
    private readonly shadows: ShadowPixels) {
    this.#luts = [24 * 256 * 8 + 128 * 8, 128 * 3 * 8, 256 * 2 * 16].map(size =>
      device.createBuffer({ label: "Azahar PICA lookup tables", size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    this.#empty = device.createTexture({ label: "Azahar empty utility image", size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING });
    this.#emptyShadow = device.createBuffer({ label: "Azahar empty shadow words", size: 4, usage: GPUBufferUsage.STORAGE });
    this.#utilitySampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest" });
  }

  static async create(device: GPUDevice, shaders: PicaShaders, textures: GraphicsTextures,
    samplers: GraphicsSamplers): Promise<GraphicsDraws> {
    return new GraphicsDraws(device, shaders, textures, samplers, await ShadowPixels.create(device));
  }

  lookupTable(table: number, offset: number, bytes: Uint8Array<ArrayBuffer>): undefined {
    this.checkOpen();
    const buffer = this.#luts[table];
    if (!buffer || !Number.isInteger(offset) || offset < 0 || offset % 4 || bytes.byteLength % 4 ||
      offset + bytes.byteLength > buffer.size) throw new Error("Invalid native lookup table upload");
    this.device.queue.writeBuffer(buffer, offset, bytes);
    return undefined;
  }

  async draw(draw: NativeDraw): Promise<undefined> {
    this.checkOpen();
    const state = draw.state;
    const stride = this.shaders.vertexLayout.arrayStride;
    if (draw.vertexUniforms.byteLength !== 32 || draw.fragmentUniforms.byteLength !== 0x530 ||
      !draw.vertices.byteLength || draw.vertices.byteLength % (stride * 3)) throw new Error("Invalid native triangle batch");
    if (!state.color && !state.depth) throw new Error("The native draw has no framebuffer");
    const colorSurface = state.color ? this.textures.get(state.color) : undefined;
    const color = colorSurface?.texture;
    const colorFormat = state.shadow ? 0 : colorSurface?.nativeFormat ?? 0;
    const depth = state.depth ? this.textures.get(state.depth).texture : undefined;
    if (state.shadow && (!color || depth)) throw new Error("Invalid native shadow framebuffer");
    const originalWidth = color ? Math.max(1, color.width >> state.colorLevel) : Math.max(1, depth!.width >> state.depthLevel);
    const originalHeight = color ? Math.max(1, color.height >> state.colorLevel) : Math.max(1, depth!.height >> state.depthLevel);
    const width = depth ? Math.max(1, depth.width >> state.depthLevel) : originalWidth;
    const height = depth ? Math.max(1, depth.height >> state.depthLevel) : originalHeight;
    const [x, y, w, h] = state.scissor;
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 ||
      x + w > Math.min(width, originalWidth) || y + h > Math.min(height, originalHeight) ||
      !state.viewport.every(Number.isFinite) || state.viewport[2] <= 0 || state.viewport[3] <= 0) {
      throw new Error("Invalid native draw rectangle");
    }
    const compiled = await this.pipeline(draw, colorFormat, color?.format, depth?.format);
    this.checkOpen();
    const alignment = this.device.limits.minUniformBufferOffsetAlignment;
    const aligned = (bytes: number): number => Math.ceil(bytes / alignment) * alignment;
    const upload = this.uploadBuffer(aligned(draw.vertices.byteLength) + aligned(draw.vertexUniforms.byteLength) +
      aligned(draw.fragmentUniforms.byteLength) + 2 * aligned(16));
    const encoder = this.#encoder ??= this.device.createCommandEncoder({ label: "Azahar PICA draws" });
    const temporary: (GPUTexture | GPUBuffer)[] = [];
    try {
      let attachment = color;
      let colorLevel = state.colorLevel;
      // Native caches may have equal subrects in images with different overall extents.
      if (color && (originalWidth !== width || originalHeight !== height)) {
        attachment = this.device.createTexture({ label: "Azahar aligned color attachment", size: [width, height],
          format: color.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        temporary.push(attachment); colorLevel = 0;
        this.endPass();
        encoder.copyTextureToTexture({ texture: color, mipLevel: state.colorLevel }, { texture: attachment },
          [Math.min(width, originalWidth), Math.min(height, originalHeight)]);
      }
      let offset = this.#uploadBytes;
      const store = (bytes: Uint8Array<ArrayBuffer>): GPUBufferBinding => {
        const binding = { buffer: upload.buffer, offset, size: bytes.byteLength };
        upload.bytes.set(bytes, offset);
        offset += aligned(bytes.byteLength);
        return binding;
      };
      // Uniform ranges share the vertex upload without exposing alignment padding to bindings.
      const vertex = store(draw.vertices);
      const vs = store(draw.vertexUniforms);
      const fs = store(draw.fragmentUniforms);
      const [vx, vy, vw, vh] = state.viewport;
      const transform = store(new Uint8Array(new Float32Array([vw / width, -vh / height,
        (2 * vx + vw) / width - 1, 1 - (2 * vy + vh) / height]).buffer));
      const dimensions = store(new Uint8Array(new Uint32Array([width, height, 0, 0]).buffer));
      let shadow = this.#emptyShadow;
      if (state.shadow) {
        this.endPass();
        shadow = this.shadows.buffer(encoder, attachment!, colorLevel); temporary.push(shadow);
      }
      const uniformGroup = this.uniformGroup(compiled, upload.buffer);
      this.#uniformOffsets[0] = vs.offset!;
      this.#uniformOffsets[1] = fs.offset!;
      this.#uniformOffsets[2] = transform.offset!;
      this.#uniformOffsets[3] = dimensions.offset!;
      const textureResources: (GPUTextureView | GPUSampler)[] = [];
      let reusableTextures = true;
      for (let i = 0; i < 3; i++) {
        let image = this.textures.get(state.textures[i]!).texture;
        if (i === 0 && (state.texture0Type === 2 || state.texture0Type === 4)) {
          this.endPass();
          image = this.shadows.image(encoder, image); temporary.push(image);
          reusableTextures = false;
        } else if (image === color || image === depth) {
          image = this.snapshot(encoder, image); temporary.push(image);
          reusableTextures = false;
        }
        const dimension: GPUTextureViewDimension = i === 0 && state.texture0Type === 1 ? "cube" :
          i === 0 && state.texture0Type === 4 ? "2d-array" : "2d";
        textureResources[i] = this.view(image, dimension);
        textureResources[i + 3] = this.samplers.get(state.samplers[i]!);
      }
      const textureGroup = this.textureGroup(compiled, textureResources, reusableTextures);
      const destRead = !!attachment && !state.shadow && this.readsDestination(state, colorFormat);
      let dest = this.#empty;
      if (destRead) {
        dest = this.device.createTexture({ label: "Azahar destination snapshot", size: [width, height],
          format: attachment!.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        temporary.push(dest);
      }
      const utilityGroup = this.utilityGroup(compiled, upload.buffer, [shadow,
        this.view(state.normal ? this.textures.get(state.normal).texture : this.#empty),
        state.normal ? this.samplers.get(state.samplers[0]) : this.#utilitySampler,
        this.view(dest)], !state.shadow && !destRead);
      const count = draw.vertices.byteLength / stride;
      // Logic ops and min/max blend factors read the result of preceding primitives.
      const step = destRead ? 3 : count;
      for (let first = 0; first < count; first += step) {
        // Destination blending fetches only the pixels admitted by this draw's scissor.
        if (destRead) {
          this.endPass();
          encoder.copyTextureToTexture({ texture: attachment!, mipLevel: colorLevel, origin: [x, y] },
            { texture: dest, origin: [x, y] }, [w, h]);
        }
        const pass = this.renderPass(encoder, attachment, colorLevel, depth, state.depthLevel);
        pass.setPipeline(compiled.pipeline); pass.setVertexBuffer(0, vertex.buffer, vertex.offset, vertex.size);
        pass.setBindGroup(0, uniformGroup, this.#uniformOffsets, 0, 3);
        pass.setBindGroup(1, textureGroup);
        pass.setBindGroup(2, utilityGroup, this.#uniformOffsets, 3, 1);
        pass.setScissorRect(x, y, w, h); pass.setStencilReference(state.stencilReference);
        const blendColor = state.blendColor >>> 0;
        pass.setBlendConstant({ r: (blendColor & 255) / 255, g: ((blendColor >>> 8) & 255) / 255,
          b: ((blendColor >>> 16) & 255) / 255, a: (blendColor >>> 24) / 255 });
        pass.draw(step, 1, first);
      }
      // Copies and shadow conversions use separate resource scopes, including subsequent draws.
      if (temporary.length) this.endPass();
      if (state.shadow) this.shadows.restore(encoder, attachment!, colorLevel, shadow, dimensions);
      if (attachment && color && attachment !== color) encoder.copyTextureToTexture({ texture: attachment },
        { texture: color, mipLevel: state.colorLevel }, [Math.min(width, originalWidth), Math.min(height, originalHeight)]);
      // Keep every resource alive until the encoder has been submitted.
      this.#temporary.push(...temporary);
      temporary.length = 0;
      this.#uploadBytes = offset;
      if (++this.#drawCount >= 16 || this.#uploadBytes >= 1024 * 1024) this.flush();
    } catch (error) {
      // A failed draw can leave an unfinished pass in the shared encoder.
      this.discard();
      throw error;
    } finally { for (const resource of temporary) resource.destroy(); }
    return undefined;
  }

  flush(): undefined {
    this.checkOpen();
    const encoder = this.#encoder;
    if (!encoder) return undefined;
    const temporary = this.#temporary;
    const upload = this.#upload!;
    const size = this.#uploadBytes;
    this.#encoder = undefined; this.#temporary = [];
    this.#drawCount = 0; this.#uploadBytes = 0;
    try {
      this.endPass();
      const commands = encoder.finish();
      // Queue order keeps earlier submissions ahead of the next upload into this buffer.
      this.device.queue.writeBuffer(upload.buffer, 0, upload.bytes.subarray(0, size));
      this.device.queue.submit([commands]);
    } finally { for (const resource of temporary) resource.destroy(); }
    return undefined;
  }

  private discard(): undefined {
    this.#encoder = undefined; this.#pass = undefined;
    for (const resource of this.#temporary) resource.destroy();
    this.#temporary = []; this.#drawCount = 0; this.#uploadBytes = 0;
    return undefined;
  }

  private endPass(): undefined {
    const pass = this.#pass;
    this.#pass = undefined;
    pass?.encoder.end();
    return undefined;
  }

  private renderPass(encoder: GPUCommandEncoder, color: GPUTexture | undefined, colorLevel: number,
    depth: GPUTexture | undefined, depthLevel: number): GPURenderPassEncoder {
    const colorView = color ? this.view(color, colorLevel) : undefined;
    const depthView = depth ? this.view(depth, depthLevel) : undefined;
    const current = this.#pass;
    if (current && current.color === colorView && current.depth === depthView) return current.encoder;
    this.endPass();
    const pass = encoder.beginRenderPass({
      colorAttachments: colorView ? [{ view: colorView, loadOp: "load", storeOp: "store" }] : [],
      ...(depthView ? { depthStencilAttachment: { view: depthView,
        depthLoadOp: "load", depthStoreOp: "store",
        ...(depth!.format === "depth24plus-stencil8" ? { stencilLoadOp: "load", stencilStoreOp: "store" } as const : {}),
      } as GPURenderPassDepthStencilAttachment } : {}),
    });
    this.#pass = { encoder: pass, color: colorView, depth: depthView };
    return pass;
  }

  private uploadBuffer(size: number): DrawUpload {
    if (size > this.device.limits.maxBufferSize) throw new Error("Native triangle upload exceeds the WebGPU buffer limit");
    if (this.#uploadBytes + size > (this.#upload?.bytes.byteLength ?? 0)) this.flush();
    if (!this.#upload || size > this.#upload.bytes.byteLength) {
      const capacity = Math.max(1024 * 1024, size);
      const bytes = new Uint8Array(capacity);
      const buffer = this.device.createBuffer({ label: "Azahar triangle batches and uniforms", size: capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#upload?.buffer.destroy();
      this.#upload = { buffer, bytes };
    }
    return this.#upload;
  }

  private readsDestination(state: NativeDrawState, colorFormat: number): boolean {
    return state.blend ? this.rgbEmulated(state, colorFormat) || state.alphaEquation >= 3 :
      ![0, 3, 4, 5, 6].includes(state.logicOp);
  }

  private rgbEmulated(state: NativeDrawState, colorFormat: number): boolean {
    const factors = [state.rgbSource, state.rgbDest];
    return colorFormat !== 0 || state.rgbEquation >= 3 || factors.some(factor => factor === 12 || factor === 13) ||
      (state.alphaEquation >= 3 && factors.some(factor => factor === 6 || factor === 7 || factor === 14));
  }

  private uniformGroup(compiled: DrawPipeline, buffer: GPUBuffer): GPUBindGroup {
    let group = compiled.uniforms.get(buffer);
    if (!group) {
      group = this.device.createBindGroup({ layout: compiled.groups[0]!, entries: [
        { binding: 1, resource: { buffer, size: 32 } },
        { binding: 2, resource: { buffer, size: 0x530 } },
        ...this.#luts.map((lut, i) => ({ binding: i + 3, resource: { buffer: lut } })),
        { binding: 6, resource: { buffer, size: 16 } },
      ] });
      compiled.uniforms.set(buffer, group);
    }
    return group;
  }

  private findGroup(groups: ResourceBindingGroup[], resources: ResourceBindingGroup["resources"]): GPUBindGroup | undefined {
    // GPU identities change when native handles are recreated or feedback images are copied.
    for (let index = groups.length - 1; index >= 0; index--) {
      const cached = groups[index]!;
      let matches = cached.resources.length === resources.length;
      for (let binding = 0; matches && binding < resources.length; binding++) {
        matches = cached.resources[binding] === resources[binding];
      }
      if (!matches) continue;
      // Move the hit to the newest position without allocating another array.
      for (let next = index; next < groups.length - 1; next++) groups[next] = groups[next + 1]!;
      groups[groups.length - 1] = cached;
      return cached.group;
    }
    return undefined;
  }

  private textureGroup(compiled: DrawPipeline, resources: readonly (GPUTextureView | GPUSampler)[],
    reusable: boolean): GPUBindGroup {
    const groups = compiled.textures;
    const cached = reusable ? this.findGroup(groups, resources) : undefined;
    if (cached) return cached;
    const group = this.device.createBindGroup({ layout: compiled.groups[1]!,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    if (reusable) {
      if (groups.length >= 16) groups.shift();
      groups.push({ resources, group });
    }
    return group;
  }

  private utilityGroup(compiled: DrawPipeline, buffer: GPUBuffer,
    resources: readonly [GPUBuffer, GPUTextureView, GPUSampler, GPUTextureView], reusable: boolean): GPUBindGroup {
    let groups = reusable ? compiled.utilities.get(buffer) : undefined;
    const cached = groups ? this.findGroup(groups, resources) : undefined;
    if (cached) return cached;
    const group = this.device.createBindGroup({ layout: compiled.groups[2]!, entries: [
      { binding: 0, resource: { buffer: resources[0] } },
      { binding: 1, resource: resources[1] }, { binding: 2, resource: resources[2] },
      { binding: 3, resource: resources[3] }, { binding: 4, resource: { buffer, size: 16 } },
    ] });
    if (reusable) {
      if (!groups) { groups = []; compiled.utilities.set(buffer, groups); }
      if (groups.length >= 16) groups.shift();
      groups.push({ resources, group });
    }
    return group;
  }

  private pipeline(draw: NativeDraw, colorFormat: number, color?: GPUTextureFormat, depth?: GPUTextureFormat): Promise<DrawPipeline> {
    const s = draw.state;
    const last = this.#lastPipeline;
    // Repeated draws already occupy the newest cache entry; compare the full signature directly.
    if (last && this.matchesPipeline(last, draw, colorFormat, color, depth)) return last.pipeline;
    const key = String.fromCharCode(...draw.configuration) + JSON.stringify([colorFormat, color, depth,
      ...pipelineStateKeys.map(field => s[field]), !!s.normal, s.shadow]);
    let pending = this.#pipelines.get(key);
    if (pending) {
      this.#pipelines.delete(key); this.#pipelines.set(key, pending);
    } else {
      // Let prior draws execute while a new native shader and pipeline are compiled.
      this.flush();
      pending = this.createPipeline(draw, colorFormat, color, depth).catch(error => {
        if (this.#pipelines.get(key) === pending) this.#pipelines.delete(key);
        if (this.#lastPipeline?.pipeline === pending) this.#lastPipeline = undefined;
        throw error;
      });
      if (this.#pipelines.size >= 512) this.#pipelines.delete(this.#pipelines.keys().next().value!);
      this.#pipelines.set(key, pending);
    }
    // Copy only the shader bytes, so the last selection does not retain the vertex upload buffer.
    this.#lastPipeline = { configuration: draw.configuration.slice(), state: { ...s }, colorFormat, color, depth,
      pipeline: pending };
    return pending;
  }

  private matchesPipeline(last: PipelineSelection, draw: NativeDraw, colorFormat: number,
    color: GPUTextureFormat | undefined, depth: GPUTextureFormat | undefined): boolean {
    if (last.colorFormat !== colorFormat || last.color !== color || last.depth !== depth ||
      !!last.state.normal !== !!draw.state.normal || last.state.shadow !== draw.state.shadow ||
      last.configuration.length !== draw.configuration.length) return false;
    for (const field of pipelineStateKeys) if (last.state[field] !== draw.state[field]) return false;
    for (let i = 0; i < last.configuration.length; i++) {
      if (last.configuration[i] !== draw.configuration[i]) return false;
    }
    return true;
  }

  private async createPipeline(draw: NativeDraw, colorFormat: number, color?: GPUTextureFormat, depth?: GPUTextureFormat): Promise<DrawPipeline> {
    const s = draw.state;
    const depthFormat = depth ? depth === "depth16unorm" ? 1 : 2 : 0;
    const fragment = await this.shaders.fragment(draw.configuration,
      Number(!!s.normal) | (colorFormat << 1) | (depthFormat << 4));
    const groups = [
      this.device.createBindGroupLayout({ entries: [
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 32, hasDynamicOffset: true } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 0x530, hasDynamicOffset: true } },
        ...[3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } as const })),
        { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 16, hasDynamicOffset: true } },
      ] }),
      this.device.createBindGroupLayout({ entries: [
        ...[0, 1, 2].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: {
          sampleType: binding === 0 && (s.texture0Type === 2 || s.texture0Type === 4) ? "uint" : "float",
          viewDimension: binding === 0 && s.texture0Type === 1 ? "cube" : binding === 0 && s.texture0Type === 4 ? "2d-array" : "2d",
        } as GPUTextureBindingLayout })),
        ...[3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } as const })),
      ] }),
      this.device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16, hasDynamicOffset: true } },
      ] }),
    ];
    const blend = (eq: number, src: number, dst: number, emulated: boolean): GPUBlendComponent => {
      // The native fragment generator implements min/max with PICA's blend factors.
      if (emulated) return { operation: "add", srcFactor: "one", dstFactor: "zero" };
      if (!equations[eq] || !factors[src] || !factors[dst]) throw new Error("Invalid native blend state");
      return { operation: equations[eq]!, srcFactor: factors[src]!, dstFactor: factors[dst]! };
    };
    const stencil: GPUStencilFaceState = s.stencil ? { compare: compares[s.stencilCompare]!,
      failOp: stencilOps[s.stencilFail]!, depthFailOp: stencilOps[s.stencilDepthFail]!, passOp: stencilOps[s.stencilPass]! } : { compare: "always" };
    const pipeline = await this.device.createRenderPipelineAsync({ label: "Azahar PICA pipeline",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: groups }),
      vertex: { module: this.shaders.vertex, entryPoint: "main", buffers: [this.shaders.vertexLayout] },
      fragment: { module: fragment, entryPoint: "main", targets: color ? [{ format: color,
        writeMask: s.shadow || (!s.blend && s.logicOp === 6) ? 0 : s.colorMask,
        ...(s.blend && !s.shadow ? { blend: { color: blend(s.rgbEquation, s.rgbSource, s.rgbDest, this.rgbEmulated(s, colorFormat)),
          alpha: blend(s.alphaEquation, s.alphaSource, s.alphaDest, colorFormat !== 0 || s.alphaEquation >= 3) } } : {}),
      }] : [] },
      primitive: { topology: "triangle-list", frontFace: s.cull === 2 ? "cw" : "ccw",
        cullMode: s.cull === 0 || s.cull === 3 ? "none" : s.flipped ? "front" : "back" },
      ...(depth ? { depthStencil: { format: depth, depthWriteEnabled: s.depthWrite, depthCompare: compares[s.depthCompare]!,
        ...(depth === "depth24plus-stencil8" ? { stencilFront: stencil, stencilBack: stencil,
          stencilReadMask: s.stencilReadMask, stencilWriteMask: s.stencil ? s.stencilWriteMask : 0 } : {}),
      } } : {}),
    });
    return { pipeline, groups, textures: [], uniforms: new WeakMap(), utilities: new WeakMap() };
  }

  private snapshot(encoder: GPUCommandEncoder, source: GPUTexture): GPUTexture {
    this.endPass();
    const copy = this.device.createTexture({ size: [source.width, source.height, source.depthOrArrayLayers],
      format: source.format, mipLevelCount: source.mipLevelCount, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    for (let level = 0; level < source.mipLevelCount; level++) encoder.copyTextureToTexture(
      { texture: source, mipLevel: level }, { texture: copy, mipLevel: level },
      [Math.max(1, source.width >> level), Math.max(1, source.height >> level), source.depthOrArrayLayers]);
    return copy;
  }

  private view(texture: GPUTexture, key?: number | GPUTextureViewDimension): GPUTextureView {
    let views = this.#views.get(texture);
    if (!views) { views = new Map(); this.#views.set(texture, views); }
    let view = views.get(key);
    if (!view) {
      view = texture.createView(typeof key === "number" ? {
        dimension: "2d", baseMipLevel: key, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1,
      } : key === undefined ? {} : { dimension: key });
      views.set(key, view);
    }
    return view;
  }

  private checkOpen(): undefined {
    if (this.#closed) throw new Error("The native draw backend is closed");
    return undefined;
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.discard();
    this.#closed = true; this.#pipelines.clear(); this.#lastPipeline = undefined;
    this.#views = new WeakMap();
    this.#upload?.buffer.destroy(); this.#upload = undefined;
    for (const buffer of this.#luts) buffer.destroy();
    this.#empty.destroy(); this.#emptyShadow.destroy();
    return undefined;
  }
}
