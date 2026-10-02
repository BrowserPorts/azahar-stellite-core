// SPDX-License-Identifier: GPL-2.0-or-later

import type { TextureSurface } from "./textures";

export interface TextureRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
  level: number;
  layer: number;
}

const commonShader = `
struct Params { source: vec4f, dest: vec4f, format: vec4u }
@group(0) @binding(2) var<uniform> params: Params;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
fn source_coord(position: vec2f) -> vec2f {
  let coord = params.source.xy + (position - params.dest.xy) / params.dest.zw * params.source.zw;
  let first = min(params.source.xy, params.source.xy + params.source.zw) + vec2f(0.5);
  let last = max(params.source.xy, params.source.xy + params.source.zw) - vec2f(0.5);
  return clamp(coord, first, last);
}
`;

const colorShader = commonShader + `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var image_sampler: sampler;
@fragment fn color(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = source_coord(position.xy) / vec2f(textureDimensions(image));
  let color = textureSampleLevel(image, image_sampler, uv, 0.0);
  let format = params.format.x;
  if (format == 1u) { return vec4f(color.rgb, 1.0); }
  if (format < 2u || format > 4u) { return color; }
  var bits = vec4u(round(clamp(color, vec4f(0.0), vec4f(1.0)) * 255.0));
  if (format == 2u) {
    bits = bits >> vec4u(3u, 3u, 3u, 7u);
    bits = vec4u((bits.rgb << vec3u(3u)) | (bits.rgb >> vec3u(2u)), bits.a * 255u);
  } else if (format == 3u) {
    bits = bits >> vec4u(3u, 2u, 3u, 0u);
    bits = vec4u((bits.rgb << vec3u(3u, 2u, 3u)) | (bits.rgb >> vec3u(2u, 4u, 2u)), 255u);
  } else {
    bits = bits >> vec4u(4u);
    bits = (bits << vec4u(4u)) | bits;
  }
  return vec4f(bits) / 255.0;
}
`;

const depthShader = commonShader + `
@group(0) @binding(0) var image: texture_depth_2d;
@group(0) @binding(1) var stencil_image: texture_2d<u32>;
override stencil_mask: u32 = 0u;
@fragment fn depth(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  let coord = vec2i(source_coord(position.xy));
  if (stencil_mask != 0u && (textureLoad(stencil_image, coord, 0).r & stencil_mask) == 0u) { discard; }
  return textureLoad(image, coord, 0);
}
`;

/** Scales and mirrors cached surfaces without a GPU-to-CPU round trip. */
export class TextureBlitter {
  #pipelines = new Map<string, Promise<GPURenderPipeline>>();
  #samplers: readonly [GPUSampler, GPUSampler];

  private constructor(
    readonly device: GPUDevice,
    private readonly colorModule: GPUShaderModule,
    private readonly depthModule: GPUShaderModule,
    private readonly emptyStencil: GPUTexture,
  ) {
    this.#samplers = [
      device.createSampler({ minFilter: "nearest", magFilter: "nearest" }),
      device.createSampler({ minFilter: "linear", magFilter: "linear" }),
    ];
  }

  static async create(device: GPUDevice, emptyStencil: GPUTexture): Promise<TextureBlitter> {
    const color = device.createShaderModule({ label: "Azahar color blit", code: colorShader });
    const depth = device.createShaderModule({ label: "Azahar depth/stencil blit", code: depthShader });
    for (const module of [color, depth]) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      if (errors.length) throw new Error(errors.map((message) => message.message).join("\n"));
    }
    const blitter = new TextureBlitter(device, color, depth, emptyStencil);
    await Promise.all([
      blitter.pipeline("rgba8unorm", 0), blitter.pipeline("depth16unorm", 0),
      blitter.pipeline("depth32float", 0),
      ...[0, 1, 2, 4, 8, 16, 32, 64, 128].map((mask) => blitter.pipeline("depth24plus-stencil8", mask)),
    ]);
    return blitter;
  }

  async blit(source: TextureSurface, dest: TextureSurface, src: TextureRect, dst: TextureRect,
    linear = true): Promise<undefined> {
    this.validate(source, src);
    this.validate(dest, dst);
    const color = source.nativeFormat <= 13 && dest.nativeFormat <= 13;
    const depth = (source.nativeFormat === 14 || source.nativeFormat === 16) &&
      (dest.nativeFormat === 14 || dest.nativeFormat === 16);
    const stencil = source.nativeFormat === 17 && dest.nativeFormat === 17;
    if (!color && !depth && !stencil) throw new Error("Incompatible native blit formats");
    const masks = stencil ? [0, 1, 2, 4, 8, 16, 32, 64, 128] : [0];
    const pipelines = await Promise.all(masks.map((mask) => this.pipeline(dest.format, mask)));
    const encoder = this.device.createCommandEncoder({ label: "Azahar surface blit" });
    let snapshot: GPUTexture | undefined;
    let input = source.texture;
    let inputRect = src;
    // A render attachment cannot also be sampled from the same subresource.
    if (input === dest.texture && src.level === dst.level && src.layer === dst.layer) {
      const size = [Math.max(1, input.width >> src.level), Math.max(1, input.height >> src.level)];
      snapshot = this.device.createTexture({ label: "Azahar blit snapshot", size, format: source.format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      encoder.copyTextureToTexture({ texture: input, mipLevel: src.level, origin: [0, 0, src.layer] },
        { texture: snapshot }, size);
      input = snapshot;
      inputRect = { ...src, level: 0, layer: 0 };
    }
    const params = this.device.createBuffer({ label: "Azahar blit rectangles", size: 48,
      usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const mapped = params.getMappedRange();
    new Float32Array(mapped).set([
      src.left, src.bottom, src.right - src.left, src.top - src.bottom,
      dst.left, dst.bottom, dst.right - dst.left, dst.top - dst.bottom,
    ]);
    new Uint32Array(mapped)[8] = dest.nativeFormat;
    params.unmap();
    try {
      const binding = this.device.createBindGroup({ layout: pipelines[0]!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.view(input, inputRect, color ? "all" : "depth-only") },
        { binding: 1, resource: color ? this.#samplers[Number(linear)]! :
          stencil ? this.view(input, inputRect, "stencil-only") : this.emptyStencil.createView() },
        { binding: 2, resource: { buffer: params } },
      ] });
      const pass = encoder.beginRenderPass({
        colorAttachments: color ? [{ view: this.view(dest.texture, dst), loadOp: "load", storeOp: "store" }] : [],
        ...(!color ? { depthStencilAttachment: {
          view: this.view(dest.texture, dst), depthLoadOp: "load", depthStoreOp: "store",
          ...(stencil ? { stencilLoadOp: "load", stencilStoreOp: "store" } as const : {}),
        } as GPURenderPassDepthStencilAttachment } : {}),
      });
      const left = Math.min(dst.left, dst.right);
      const bottom = Math.min(dst.bottom, dst.top);
      pass.setScissorRect(left, bottom, Math.abs(dst.right - dst.left), Math.abs(dst.top - dst.bottom));
      for (let i = 0; i < pipelines.length; i++) {
        pass.setPipeline(pipelines[i]!);
        pass.setBindGroup(0, binding);
        if (stencil) pass.setStencilReference(i === 0 ? 0 : 255);
        pass.draw(3);
      }
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } finally { params.destroy(); snapshot?.destroy(); }
    return undefined;
  }

  private pipeline(format: GPUTextureFormat, mask: number): Promise<GPURenderPipeline> {
    const key = `${format}:${mask}`;
    const cached = this.#pipelines.get(key);
    if (cached) return cached;
    const color = format === "rgba8unorm";
    const module = color ? this.colorModule : this.depthModule;
    const layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: color ? "float" : "depth" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        ...(color ? { sampler: { type: "filtering" } as const } : { texture: { sampleType: "uint" } as const }) },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const pipeline = this.device.createRenderPipelineAsync({
      label: "Azahar surface blit", layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vertex" },
      fragment: { module, entryPoint: color ? "color" : "depth", targets: color ? [{ format }] : [],
        ...(!color ? { constants: { stencil_mask: mask } } : {}) },
      primitive: { topology: "triangle-list" },
      ...(!color ? { depthStencil: { format, depthCompare: "always", depthWriteEnabled: mask === 0,
        ...(format === "depth24plus-stencil8" ? {
          stencilFront: { compare: "always", passOp: "replace" },
          stencilBack: { compare: "always", passOp: "replace" },
          stencilWriteMask: mask === 0 ? 255 : mask,
        } as const : {}),
      } as GPUDepthStencilState } : {}),
    });
    this.#pipelines.set(key, pipeline);
    return pipeline;
  }

  private view(texture: GPUTexture, rect: TextureRect, aspect: GPUTextureAspect = "all"): GPUTextureView {
    return texture.createView({ dimension: "2d", baseMipLevel: rect.level, mipLevelCount: 1,
      baseArrayLayer: rect.layer, arrayLayerCount: 1, aspect });
  }

  private validate(surface: TextureSurface, rect: TextureRect): undefined {
    const texture = surface.texture;
    const width = Math.max(1, texture.width >> rect.level);
    const height = Math.max(1, texture.height >> rect.level);
    if (!Object.values(rect).every(Number.isInteger) || rect.level < 0 || rect.level >= texture.mipLevelCount ||
      rect.layer < 0 || rect.layer >= texture.depthOrArrayLayers || rect.left < 0 || rect.right < 0 ||
      rect.bottom < 0 || rect.top < 0 || rect.left > width || rect.right > width ||
      rect.top > height || rect.bottom > height || rect.left === rect.right || rect.top === rect.bottom) {
      throw new Error("Invalid native blit rectangle");
    }
    return undefined;
  }

  close(): undefined {
    this.#pipelines.clear();
    return undefined;
  }
}
