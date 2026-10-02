// SPDX-License-Identifier: GPL-2.0-or-later

const packShader = `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var image: texture_storage_2d_array<r32uint, write>;
@group(0) @binding(2) var<storage, read_write> pixels: array<u32>;
fn packed(coord: vec3u) -> u32 {
  let color = vec4u(round(clamp(textureLoad(source, vec2i(coord.xy), i32(coord.z), 0), vec4f(0), vec4f(1)) * 255.0));
  return (color.r << 24u) | (color.g << 16u) | (color.b << 8u) | color.a;
}
@compute @workgroup_size(8, 8) fn pack_image(@builtin(global_invocation_id) coord: vec3u) {
  if (any(coord.xy >= textureDimensions(source)) || coord.z >= textureNumLayers(source)) { return; }
  textureStore(image, vec2i(coord.xy), i32(coord.z), vec4u(packed(coord), 0, 0, 0));
}
@compute @workgroup_size(8, 8) fn pack_buffer(@builtin(global_invocation_id) coord: vec3u) {
  if (any(coord.xy >= textureDimensions(source))) { return; }
  pixels[coord.x + coord.y * textureDimensions(source).x] = packed(coord);
}
`;

const restoreShader = `
@group(0) @binding(0) var<storage, read> pixels: array<u32>;
@group(0) @binding(1) var<uniform> dimensions: vec2u;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn restore(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coord = vec2u(position.xy);
  let pixel = pixels[coord.x + coord.y * dimensions.x];
  return vec4f(vec4u(pixel >> 24u, (pixel >> 16u) & 255u, (pixel >> 8u) & 255u, pixel & 255u)) / 255.0;
}
`;

/** Bridges the native ABGR shadow word and the cache's decoded RGBA surfaces on the GPU. */
export class ShadowPixels {
  private constructor(readonly device: GPUDevice, private readonly imagePipeline: GPUComputePipeline,
    private readonly bufferPipeline: GPUComputePipeline, private readonly restorePipeline: GPURenderPipeline) {}

  static async create(device: GPUDevice): Promise<ShadowPixels> {
    const pack = device.createShaderModule({ label: "Azahar packed shadow pixels", code: packShader });
    const restore = device.createShaderModule({ label: "Azahar shadow surface restore", code: restoreShader });
    for (const module of [pack, restore]) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => message.message).join("\n"));
    }
    const [imagePipeline, bufferPipeline, restorePipeline] = await Promise.all([
      device.createComputePipelineAsync({ layout: "auto", compute: { module: pack, entryPoint: "pack_image" } }),
      device.createComputePipelineAsync({ layout: "auto", compute: { module: pack, entryPoint: "pack_buffer" } }),
      device.createRenderPipelineAsync({ layout: "auto", vertex: { module: restore, entryPoint: "vertex" },
        fragment: { module: restore, entryPoint: "restore", targets: [{ format: "rgba8unorm" }] } }),
    ]);
    return new ShadowPixels(device, imagePipeline, bufferPipeline, restorePipeline);
  }

  image(encoder: GPUCommandEncoder, source: GPUTexture): GPUTexture {
    if (source.format !== "rgba8unorm") throw new Error("A shadow source must be a native color surface");
    const image = this.device.createTexture({ label: "Azahar shadow image", format: "r32uint",
      size: [source.width, source.height, source.depthOrArrayLayers],
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const group = this.device.createBindGroup({ layout: this.imagePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: source.createView({ dimension: "2d-array", baseMipLevel: 0, mipLevelCount: 1 }) },
      { binding: 1, resource: image.createView({ dimension: "2d-array" }) },
    ] });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.imagePipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(source.width / 8), Math.ceil(source.height / 8), source.depthOrArrayLayers);
    pass.end();
    return image;
  }

  buffer(encoder: GPUCommandEncoder, source: GPUTexture, level: number): GPUBuffer {
    if (source.format !== "rgba8unorm") throw new Error("A shadow target must be a native color surface");
    const width = Math.max(1, source.width >> level), height = Math.max(1, source.height >> level);
    const pixels = this.device.createBuffer({ label: "Azahar shadow words", size: width * height * 4,
      usage: GPUBufferUsage.STORAGE });
    const group = this.device.createBindGroup({ layout: this.bufferPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: source.createView({ dimension: "2d-array", baseMipLevel: level,
        mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }) },
      { binding: 2, resource: { buffer: pixels } },
    ] });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.bufferPipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    return pixels;
  }

  restore(encoder: GPUCommandEncoder, target: GPUTexture, level: number, pixels: GPUBuffer,
    dimensions: GPUBuffer): undefined {
    const group = this.device.createBindGroup({ layout: this.restorePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: pixels } }, { binding: 1, resource: { buffer: dimensions } },
    ] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView({ dimension: "2d",
      baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }), loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(this.restorePipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    return undefined;
  }
}
