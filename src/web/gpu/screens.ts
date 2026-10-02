// SPDX-License-Identifier: GPL-2.0-or-later

import { GraphicsTextures } from "./textures";

export interface ScreenQuad {
  left: number;
  right: number;
  mode: number;
  opacity: number;
  rows: number;
  vertices: Float32Array<ArrayBufferLike>;
}

export interface ScreenFrame {
  width: number;
  height: number;
  background: readonly number[];
  linear: boolean;
  quads: readonly ScreenQuad[];
}

const shader = `
struct Params { frame: vec4f, mode: vec4u }
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var left_image: texture_2d<f32>;
@group(0) @binding(1) var right_image: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;
@group(0) @binding(3) var<uniform> params: Params;

@vertex fn vertex(@location(0) position: vec2f, @location(1) uv: vec2f) -> Vertex {
  return Vertex(vec4f(position / params.frame.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}

@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  if (params.mode.x == 6u) { return vec4f(1.0); }
  let left = textureSample(left_image, image_sampler, input.uv).rgb;
  let right = textureSample(right_image, image_sampler, input.uv).rgb;
  var color = left;
  if (params.mode.x == 3u) {
    // Azahar's native Dubois red-cyan matrices, with GLSL row-vector multiplication.
    let l = mat3x3f(vec3f(0.437, 0.449, 0.164), vec3f(-0.062, -0.062, -0.024), vec3f(-0.048, -0.050, -0.017));
    let r = mat3x3f(vec3f(-0.011, -0.032, -0.007), vec3f(0.377, 0.761, 0.009), vec3f(-0.026, -0.093, 1.234));
    color = left * l + right * r;
  } else if (params.mode.x == 4u || params.mode.x == 5u) {
    let row = i32(params.frame.w * input.uv.x);
    color = select(right, left, row % 2 == i32(params.mode.x - 4u));
  }
  return vec4f(color, params.frame.z);
}
`;

/** Composes Azahar's native screen quads directly from cached GPU surfaces. */
export class GraphicsScreens {
  private constructor(readonly device: GPUDevice, private readonly textures: GraphicsTextures,
    private readonly pipeline: GPURenderPipeline, private readonly samplers: readonly GPUSampler[],
    private readonly empty: GPUTexture) {}

  static async create(device: GPUDevice, textures: GraphicsTextures): Promise<GraphicsScreens> {
    const module = device.createShaderModule({ label: "Azahar screen composition", code: shader });
    const pipeline = await device.createRenderPipelineAsync({
      label: "Azahar screen composition", layout: "auto",
      vertex: { module, entryPoint: "vertex", buffers: [{ arrayStride: 16, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" },
        { shaderLocation: 1, offset: 8, format: "float32x2" },
      ] }] },
      fragment: { module, entryPoint: "fragment", targets: [{ format: navigator.gpu.getPreferredCanvasFormat(),
        blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "zero", dstFactor: "one" } } }] },
      primitive: { topology: "triangle-strip" },
    });
    const samplers = (["nearest", "linear"] as const).map(filter => device.createSampler({
      minFilter: filter, magFilter: filter, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    }));
    const empty = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
    return new GraphicsScreens(device, textures, pipeline, samplers, empty);
  }

  render(target: GPUTexture, frame: ScreenFrame): undefined {
    const { width, height, background } = frame;
    if (![width, height].every(Number.isInteger) || width < 1 || height < 1 ||
      target.width !== width || target.height !== height || background.length !== 4 ||
      !background.every(Number.isFinite)) throw new Error("Invalid native screen layout");
    const buffers: GPUBuffer[] = [];
    const buffer = (data: ArrayBufferView<ArrayBufferLike>, usage: GPUBufferUsageFlags): GPUBuffer => {
      const resource = this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
      new Uint8Array(resource.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      resource.unmap(); buffers.push(resource); return resource;
    };
    try {
      const encoder = this.device.createCommandEncoder({ label: "Azahar native screens" });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
        clearValue: background, loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(this.pipeline);
      for (const quad of frame.quads) {
        if (quad.vertices.length !== 16 || !quad.vertices.every(Number.isFinite) ||
          ![0, 3, 4, 5, 6].includes(quad.mode) || !Number.isFinite(quad.rows) || quad.rows <= 0 ||
          !Number.isFinite(quad.opacity) || quad.opacity < 0 || quad.opacity > 1) {
          throw new Error("Invalid native screen quad");
        }
        const left = quad.mode === 6 ? this.empty : this.textures.get(quad.left).texture;
        const right = quad.mode === 6 ? this.empty : this.textures.get(quad.right).texture;
        const params = new ArrayBuffer(32);
        new Float32Array(params).set([width, height, quad.opacity, quad.rows]);
        new Uint32Array(params)[4] = quad.mode;
        const uniform = buffer(new Uint8Array(params), GPUBufferUsage.UNIFORM);
        const vertices = buffer(quad.vertices, GPUBufferUsage.VERTEX);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: left.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }) },
          { binding: 1, resource: right.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }) },
          { binding: 2, resource: this.samplers[Number(frame.linear)]! },
          { binding: 3, resource: { buffer: uniform } },
        ] }));
        pass.setVertexBuffer(0, vertices); pass.draw(4);
      }
      pass.end(); this.device.queue.submit([encoder.finish()]);
    } finally { for (const resource of buffers) resource.destroy(); }
    return undefined;
  }

  close(): undefined { this.empty.destroy(); return undefined; }
}
