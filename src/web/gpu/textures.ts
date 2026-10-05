// SPDX-License-Identifier: GPL-2.0-or-later

import { TextureBlitter, type TextureRect } from "./blits";

export interface TextureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  layer: number;
}

export interface TextureSurface {
  readonly texture: GPUTexture;
  readonly nativeFormat: number;
  readonly format: GPUTextureFormat;
  readonly bytesPerPixel: number;
}

// Entries are indexed by VideoCore::CustomPixelFormat minus one; RGBA8 uses the ordinary upload.
const compressedCustomFormats = [
  { format: "bc1-rgba-unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
  { format: "bc3-rgba-unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
  { format: "bc5-rg-unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
  { format: "bc7-rgba-unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
  { format: "astc-4x4-unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
  { format: "astc-6x6-unorm", blockWidth: 6, blockHeight: 6, bytesPerBlock: 16 },
  // Native ASTC8 is an 8x6 format in both the DDS/KTX loader and native renderers.
  { format: "astc-8x6-unorm", blockWidth: 8, blockHeight: 6, bytesPerBlock: 16 },
] as const;

const uploadShader = `
struct Params { region: vec4u, format: u32 }
@group(0) @binding(0) var<storage, read> pixels: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;
override stencil_mask: u32 = 0u;

@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

@fragment fn depth(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  let coord = vec2u(position.xy) - params.region.xy;
  let index = coord.x + coord.y * params.region.z;
  if (params.format == 14u) {
    let packed = pixels[index / 2u];
    return f32((packed >> ((index & 1u) * 16u)) & 65535u) / 65535.0;
  }
  let packed = pixels[index];
  if (params.format == 16u) { return bitcast<f32>(packed); }
  if (stencil_mask != 0u && (packed & stencil_mask) == 0u) { discard; }
  return f32(packed >> 8u) / 16777215.0;
}
`;

const downloadShader = `
struct Params { region: vec4u, dispatch_stride: u32, format: u32 }
@group(0) @binding(0) var depth_image: texture_depth_2d;
@group(0) @binding(1) var stencil_image: texture_2d<u32>;
@group(0) @binding(2) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn depth_at(index: u32) -> f32 {
  let coord = params.region.xy + vec2u(index % params.region.z, index / params.region.z);
  return textureLoad(depth_image, vec2i(coord), 0);
}

@compute @workgroup_size(64) fn download(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x + id.y * params.dispatch_stride;
  let count = params.region.z * params.region.w;
  if (params.format == 14u) {
    let first = index * 2u;
    if (first >= count) { return; }
    var packed = u32(round(clamp(depth_at(first), 0.0, 1.0) * 65535.0));
    if (first + 1u < count) {
      packed |= u32(round(clamp(depth_at(first + 1u), 0.0, 1.0) * 65535.0)) << 16u;
    }
    pixels[index] = packed;
    return;
  }
  if (index >= count) { return; }
  let value = clamp(depth_at(index), 0.0, 1.0);
  if (params.format == 16u) { pixels[index] = bitcast<u32>(value); return; }
  let coord = params.region.xy + vec2u(index % params.region.z, index / params.region.z);
  let stencil = textureLoad(stencil_image, vec2i(coord), 0).r & 255u;
  pixels[index] = (u32(round(value * 16777215.0)) << 8u) | stencil;
}
`;

const clearShader = `
@group(0) @binding(0) var<uniform> value: vec4f;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
@fragment fn color() -> @location(0) vec4f { return value; }
@fragment fn depth() -> @builtin(frag_depth) f32 { return value.x; }
`;

/** GPU surfaces consume the formats produced by Azahar's native texture codec. */
export class GraphicsTextures {
  #surfaces = new Map<number, TextureSurface>();
  #uploadPipelines = new Map<string, Promise<GPURenderPipeline>>();
  #clearPipelines = new Map<GPUTextureFormat, Promise<GPURenderPipeline>>();
  #closed = false;

  private constructor(
    readonly device: GPUDevice,
    private readonly uploadModule: GPUShaderModule,
    private readonly uploadLayout: GPUBindGroupLayout,
    private readonly clearModule: GPUShaderModule,
    private readonly downloadPipeline: GPUComputePipeline,
    private readonly nullStencil: GPUTexture,
    private readonly blitter: TextureBlitter,
  ) {}

  static async create(device: GPUDevice): Promise<GraphicsTextures> {
    const uploadModule = device.createShaderModule({ label: "Azahar depth upload", code: uploadShader });
    const downloadModule = device.createShaderModule({ label: "Azahar depth download", code: downloadShader });
    const clearModule = device.createShaderModule({ label: "Azahar surface clear", code: clearShader });
    for (const module of [uploadModule, downloadModule, clearModule]) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      if (errors.length) throw new Error(errors.map((message) => message.message).join("\n"));
    }
    const uploadLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const downloadPipeline = await device.createComputePipelineAsync({
      label: "Azahar native depth readback", layout: "auto",
      compute: { module: downloadModule, entryPoint: "download" },
    });
    const nullStencil = device.createTexture({
      label: "Azahar empty stencil", size: [1, 1], format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    let blitter: TextureBlitter;
    try { blitter = await TextureBlitter.create(device, nullStencil); }
    catch (error) { nullStencil.destroy(); throw error; }
    const textures = new GraphicsTextures(device, uploadModule, uploadLayout, clearModule, downloadPipeline, nullStencil, blitter);
    try {
      await Promise.all([
        textures.uploadPipeline("depth16unorm", 0), textures.uploadPipeline("depth32float", 0),
        ...[0, 1, 2, 4, 8, 16, 32, 64, 128].map((mask) => textures.uploadPipeline("depth24plus-stencil8", mask)),
        ...(["rgba8unorm", "depth16unorm", "depth32float", "depth24plus-stencil8"] as const)
          .map((format) => textures.clearPipeline(format)),
      ]);
      return textures;
    } catch (error) { textures.close(); throw error; }
  }

  create(id: number, width: number, height: number, levels: number, layers: number,
    nativeFormat: number): undefined {
    this.checkOpen();
    const limit = this.device.limits.maxTextureDimension2D;
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || this.#surfaces.has(id) ||
      ![width, height, levels, layers, nativeFormat].every(Number.isInteger) ||
      width < 1 || height < 1 || width > limit || height > limit ||
      levels < 1 || levels > Math.floor(Math.log2(Math.max(width, height))) + 1 ||
      (layers !== 1 && layers !== 6) || (layers === 6 && width !== height)) {
      throw new Error("Invalid native texture allocation");
    }
    let format: GPUTextureFormat;
    if (nativeFormat >= 0 && nativeFormat <= 13) format = "rgba8unorm";
    else if (nativeFormat === 14) format = "depth16unorm";
    else if (nativeFormat === 16) format = "depth32float";
    else if (nativeFormat === 17) format = "depth24plus-stencil8";
    else throw new Error("Unsupported native texture format");
    const texture = this.device.createTexture({
      label: `Azahar surface ${id}`, size: { width, height, depthOrArrayLayers: layers },
      mipLevelCount: levels, format,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#surfaces.set(id, { texture, nativeFormat, format, bytesPerPixel: nativeFormat === 14 ? 2 : 4 });
    return undefined;
  }

  async clear(id: number, region: TextureRegion, value: readonly number[], stencil = 0): Promise<undefined> {
    const surface = this.get(id);
    this.validateRegion(surface, region);
    const color = surface.nativeFormat <= 13;
    if (value.length !== 4 || !value.every(Number.isFinite) ||
      (!color && (value[0]! < 0 || value[0]! > 1)) ||
      !Number.isInteger(stencil) || stencil < 0 || stencil > 255) throw new Error("Invalid native texture clear value");
    const full = region.x === 0 && region.y === 0 &&
      region.width === Math.max(1, surface.texture.width >> region.level) &&
      region.height === Math.max(1, surface.texture.height >> region.level);
    const pipeline = full ? undefined : await this.clearPipeline(surface.format);
    const params = full ? undefined : this.buffer(new Float32Array(value), GPUBufferUsage.UNIFORM,
      "Azahar surface clear value");
    try {
      const encoder = this.device.createCommandEncoder({ label: "Azahar surface clear" });
      const pass = encoder.beginRenderPass({
        colorAttachments: color ? [{ view: this.attachment(surface, region),
          loadOp: full ? "clear" : "load", storeOp: "store", clearValue: value }] : [],
        ...(!color ? { depthStencilAttachment: {
          view: this.attachment(surface, region), depthLoadOp: full ? "clear" : "load",
          depthStoreOp: "store", depthClearValue: value[0]!,
          ...(surface.nativeFormat === 17 ? { stencilLoadOp: full ? "clear" : "load",
            stencilStoreOp: "store", stencilClearValue: stencil } as const : {}),
        } as GPURenderPassDepthStencilAttachment } : {}),
      });
      if (pipeline && params) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: params } }] }));
        pass.setScissorRect(region.x, region.y, region.width, region.height);
        if (surface.nativeFormat === 17) pass.setStencilReference(stencil);
        pass.draw(3);
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } finally { params?.destroy(); }
    return undefined;
  }

  get(id: number): TextureSurface {
    this.checkOpen();
    const surface = this.#surfaces.get(id);
    if (!surface) throw new Error(`Unknown native texture ${id}`);
    return surface;
  }

  async copy(sourceId: number, destId: number, src: TextureRegion, dst: TextureRegion): Promise<undefined> {
    const source = this.get(sourceId);
    const dest = this.get(destId);
    this.validateRegion(source, src);
    this.validateRegion(dest, dst);
    if (src.width !== dst.width || src.height !== dst.height) throw new Error("Native copy extents differ");
    const full = (surface: TextureSurface, region: TextureRegion): boolean => region.x === 0 && region.y === 0 &&
      region.width === Math.max(1, surface.texture.width >> region.level) &&
      region.height === Math.max(1, surface.texture.height >> region.level);
    if (source.texture !== dest.texture && source.format === dest.format &&
      (source.nativeFormat === dest.nativeFormat || dest.nativeFormat === 0) &&
      (source.nativeFormat <= 13 || (full(source, src) && full(dest, dst)))) {
      const encoder = this.device.createCommandEncoder({ label: "Azahar surface copy" });
      encoder.copyTextureToTexture({ texture: source.texture, mipLevel: src.level, origin: [src.x, src.y, src.layer] },
        { texture: dest.texture, mipLevel: dst.level, origin: [dst.x, dst.y, dst.layer] }, [src.width, src.height]);
      this.device.queue.submit([encoder.finish()]);
      return undefined;
    }
    const rect = (region: TextureRegion): TextureRect => ({ left: region.x, bottom: region.y,
      right: region.x + region.width, top: region.y + region.height, level: region.level, layer: region.layer });
    return this.blitter.blit(source, dest, rect(src), rect(dst), false);
  }

  blit(sourceId: number, destId: number, src: TextureRect, dst: TextureRect): Promise<undefined> {
    return this.blitter.blit(this.get(sourceId), this.get(destId), src, dst);
  }

  async mipmaps(id: number): Promise<undefined> {
    const surface = this.get(id);
    const texture = surface.texture;
    for (let layer = 0; layer < texture.depthOrArrayLayers; layer++) {
      for (let level = 1; level < texture.mipLevelCount; level++) {
        await this.blitter.blit(surface, surface, {
          left: 0, bottom: 0, right: Math.max(1, texture.width >> (level - 1)),
          top: Math.max(1, texture.height >> (level - 1)), level: level - 1, layer,
        }, { left: 0, bottom: 0, right: Math.max(1, texture.width >> level),
          top: Math.max(1, texture.height >> level), level, layer });
      }
    }
    return undefined;
  }

  destroy(id: number): undefined {
    this.get(id).texture.destroy();
    this.#surfaces.delete(id);
    return undefined;
  }

  async uploadCustom(id: number, region: TextureRegion, format: number,
    bytes: Uint8Array<ArrayBuffer>): Promise<undefined> {
    const dest = this.get(id);
    this.validateRegion(dest, region);
    if (dest.nativeFormat !== 0) throw new Error("Custom textures require an RGBA8 surface");
    if (format === 0) return this.upload(id, region, bytes);
    const info = compressedCustomFormats[format - 1];
    if (!Number.isInteger(format) || !info) throw new Error("Unsupported custom texture format");
    const feature = format >= 5 ? "texture-compression-astc" : "texture-compression-bc";
    if (!this.device.features.has(feature)) {
      throw new Error(`This WebGPU adapter does not support ${info.format} replacement textures`);
    }
    const { blockWidth, blockHeight, bytesPerBlock } = info;
    const columns = Math.ceil(region.width / blockWidth), rows = Math.ceil(region.height / blockHeight);
    if (bytes.byteLength !== columns * rows * bytesPerBlock) throw new Error("Invalid compressed texture upload size");
    const width = columns * blockWidth, height = rows * blockHeight;
    if (width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new Error("Compressed texture exceeds the WebGPU texture size limit");
    }
    // Decode once on the GPU into the mutable surface used by mipmaps and cache copies.
    // Block padding stays outside the source rectangle, including mip levels smaller than a block.
    const texture = this.device.createTexture({ label: "Azahar compressed replacement upload",
      size: [width, height], format: info.format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    try {
      this.device.queue.writeTexture({ texture }, bytes,
        { bytesPerRow: columns * bytesPerBlock, rowsPerImage: rows }, [width, height]);
      await this.blitter.blit({ texture, nativeFormat: 0, format: info.format, bytesPerPixel: 0 }, dest,
        { left: 0, bottom: 0, right: region.width, top: region.height, level: 0, layer: 0 },
        { left: region.x, bottom: region.y, right: region.x + region.width, top: region.y + region.height,
          level: region.level, layer: region.layer }, false);
    } finally { texture.destroy(); }
    return undefined;
  }

  async upload(id: number, region: TextureRegion, bytes: Uint8Array<ArrayBuffer>): Promise<undefined> {
    const surface = this.get(id);
    this.validateRegion(surface, region);
    const size = region.width * region.height * surface.bytesPerPixel;
    if (bytes.byteLength !== size) throw new Error("Invalid native texture upload size");
    if (surface.nativeFormat <= 13) {
      this.device.queue.writeTexture({ texture: surface.texture, mipLevel: region.level,
        origin: [region.x, region.y, region.layer] }, bytes,
      { bytesPerRow: region.width * 4, rowsPerImage: region.height }, [region.width, region.height]);
      return undefined;
    }
    const masks = surface.nativeFormat === 17 ? [0, 1, 2, 4, 8, 16, 32, 64, 128] : [0];
    const pipelines = await Promise.all(masks.map((mask) => this.uploadPipeline(surface.format, mask)));
    const pixels = this.buffer(bytes, GPUBufferUsage.STORAGE, "Azahar native depth pixels");
    const params = this.buffer(new Uint32Array([region.x, region.y, region.width, region.height,
      surface.nativeFormat, 0, 0, 0]), GPUBufferUsage.UNIFORM, "Azahar depth upload parameters");
    try {
      const binding = this.device.createBindGroup({ layout: this.uploadLayout, entries: [
        { binding: 0, resource: { buffer: pixels } }, { binding: 1, resource: { buffer: params } },
      ] });
      const encoder = this.device.createCommandEncoder({ label: "Azahar depth upload" });
      const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: this.attachment(surface, region), depthLoadOp: "load", depthStoreOp: "store",
        ...(surface.nativeFormat === 17 ? { stencilLoadOp: "load", stencilStoreOp: "store" } as const : {}),
      } });
      pass.setBindGroup(0, binding);
      pass.setScissorRect(region.x, region.y, region.width, region.height);
      for (let i = 0; i < pipelines.length; i++) {
        pass.setPipeline(pipelines[i]!);
        if (surface.nativeFormat === 17) pass.setStencilReference(i === 0 ? 0 : 255);
        pass.draw(3);
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } finally { pixels.destroy(); params.destroy(); }
    return undefined;
  }

  async download(id: number, region: TextureRegion,
    destination: Uint8Array<SharedArrayBuffer>): Promise<undefined> {
    const surface = this.get(id);
    this.validateRegion(surface, region);
    const rowSize = region.width * surface.bytesPerPixel;
    if (destination.byteLength !== rowSize * region.height) throw new Error("Invalid native texture readback size");
    const rowPitch = surface.nativeFormat <= 13 ? Math.ceil(rowSize / 256) * 256 : rowSize;
    const size = Math.ceil(rowPitch * region.height / 4) * 4;
    if (size > this.device.limits.maxBufferSize || (surface.nativeFormat > 13 &&
      size > this.device.limits.maxStorageBufferBindingSize)) {
      throw new Error("Native texture readback exceeds the device buffer limit");
    }
    const readback = this.device.createBuffer({ label: "Azahar texture readback", size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let storage: GPUBuffer | undefined;
    let params: GPUBuffer | undefined;
    try {
      const encoder = this.device.createCommandEncoder({ label: "Azahar native surface readback" });
      if (surface.nativeFormat <= 13) {
        encoder.copyTextureToBuffer({ texture: surface.texture, mipLevel: region.level,
          origin: [region.x, region.y, region.layer] }, { buffer: readback, bytesPerRow: rowPitch },
        [region.width, region.height]);
      } else {
        storage = this.device.createBuffer({ label: "Azahar packed depth readback", size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const count = Math.ceil(region.width * region.height / (surface.nativeFormat === 14 ? 2 : 1));
        const columns = Math.min(Math.ceil(count / 64), this.device.limits.maxComputeWorkgroupsPerDimension);
        params = this.buffer(new Uint32Array([region.x, region.y, region.width, region.height,
          columns * 64, surface.nativeFormat, 0, 0]), GPUBufferUsage.UNIFORM, "Azahar depth readback parameters");
        const binding = this.device.createBindGroup({ layout: this.downloadPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.attachment(surface, region, "depth-only") },
            { binding: 1, resource: surface.nativeFormat === 17 ?
              this.attachment(surface, region, "stencil-only") : this.nullStencil.createView() },
            { binding: 2, resource: { buffer: storage } }, { binding: 3, resource: { buffer: params } },
          ] });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.downloadPipeline);
        pass.setBindGroup(0, binding);
        pass.dispatchWorkgroups(columns, Math.ceil(count / (columns * 64)));
        pass.end();
        encoder.copyBufferToBuffer(storage, 0, readback, 0, size);
      }
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readback.getMappedRange());
      // Copy directly into native staging memory while the emulation worker is waiting.
      if (rowSize === rowPitch) destination.set(mapped.subarray(0, destination.byteLength));
      else for (let y = 0; y < region.height; y++) {
        destination.set(mapped.subarray(y * rowPitch, y * rowPitch + rowSize), y * rowSize);
      }
      return undefined;
    } finally { readback.destroy(); storage?.destroy(); params?.destroy(); }
  }

  private uploadPipeline(format: GPUTextureFormat, mask: number): Promise<GPURenderPipeline> {
    const key = `${format}:${mask}`;
    const cached = this.#uploadPipelines.get(key);
    if (cached) return cached;
    const pipeline = this.device.createRenderPipelineAsync({
      label: "Azahar native depth upload", layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.uploadLayout] }),
      vertex: { module: this.uploadModule, entryPoint: "vertex" },
      fragment: { module: this.uploadModule, entryPoint: "depth", targets: [], constants: { stencil_mask: mask } },
      primitive: { topology: "triangle-list" },
      depthStencil: { format, depthCompare: "always", depthWriteEnabled: mask === 0,
        ...(format === "depth24plus-stencil8" ? {
          stencilFront: { compare: "always", passOp: "replace" },
          stencilBack: { compare: "always", passOp: "replace" },
          stencilWriteMask: mask === 0 ? 255 : mask,
        } as const : {}),
      },
    });
    this.#uploadPipelines.set(key, pipeline);
    return pipeline;
  }

  private clearPipeline(format: GPUTextureFormat): Promise<GPURenderPipeline> {
    const cached = this.#clearPipelines.get(format);
    if (cached) return cached;
    const color = format === "rgba8unorm";
    const pipeline = this.device.createRenderPipelineAsync({
      label: "Azahar surface clear", layout: "auto",
      vertex: { module: this.clearModule, entryPoint: "vertex" },
      fragment: { module: this.clearModule, entryPoint: color ? "color" : "depth",
        targets: color ? [{ format }] : [] },
      primitive: { topology: "triangle-list" },
      ...(!color ? { depthStencil: { format, depthCompare: "always", depthWriteEnabled: true,
        ...(format === "depth24plus-stencil8" ? {
          stencilFront: { compare: "always", passOp: "replace" },
          stencilBack: { compare: "always", passOp: "replace" },
          stencilWriteMask: 255,
        } as const : {}),
      } as GPUDepthStencilState } : {}),
    });
    this.#clearPipelines.set(format, pipeline);
    return pipeline;
  }

  private buffer(bytes: ArrayBufferView<ArrayBuffer>, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const size = Math.ceil(bytes.byteLength / 4) * 4;
    if (size > this.device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > this.device.limits.maxStorageBufferBindingSize)) {
      throw new Error("Native texture data exceeds the device buffer limit");
    }
    const buffer = this.device.createBuffer({ label, size,
      usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    buffer.unmap();
    return buffer;
  }

  private attachment(surface: TextureSurface, region: TextureRegion, aspect: GPUTextureAspect = "all"): GPUTextureView {
    return surface.texture.createView({ dimension: "2d", baseMipLevel: region.level, mipLevelCount: 1,
      baseArrayLayer: region.layer, arrayLayerCount: 1, aspect });
  }

  private validateRegion(surface: TextureSurface, region: TextureRegion): undefined {
    const texture = surface.texture;
    if (![region.x, region.y, region.width, region.height, region.level, region.layer].every(Number.isInteger) ||
      region.level < 0 || region.level >= texture.mipLevelCount || region.layer < 0 ||
      region.layer >= texture.depthOrArrayLayers || region.x < 0 || region.y < 0 ||
      region.width < 1 || region.height < 1 ||
      region.x + region.width > Math.max(1, texture.width >> region.level) ||
      region.y + region.height > Math.max(1, texture.height >> region.level)) {
      throw new Error("Invalid native texture region");
    }
    return undefined;
  }

  private checkOpen(): undefined {
    if (this.#closed) throw new Error("The native texture runtime is closed");
    return undefined;
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    for (const surface of this.#surfaces.values()) surface.texture.destroy();
    this.#surfaces.clear();
    this.#uploadPipelines.clear();
    this.#clearPipelines.clear();
    this.nullStencil.destroy();
    this.blitter.close();
    return undefined;
  }
}
