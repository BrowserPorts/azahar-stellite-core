// SPDX-License-Identifier: GPL-2.0-or-later

import { GraphicsScreens, type ScreenFrame } from "./screens";

const shader = `
@group(0) @binding(0) var pixels: texture_2d<f32>;

@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = textureLoad(pixels, vec2i(position.xy), 0);
  return vec4f(color.rgb, 1.0);
}
`;

/** Presents the native XRGB8888 framebuffer without a transfer to the main thread. */
export class WebGpuPresenter {
  #texture: GPUTexture | undefined;
  #binding: GPUBindGroup | undefined;
  #width = 0;
  #height = 0;
  #closed = false;
  #failure: string | undefined;

  private constructor(
    readonly canvas: OffscreenCanvas,
    readonly device: GPUDevice,
    readonly context: GPUCanvasContext,
    readonly pipeline: GPURenderPipeline,
    readonly onError: (message: string) => unknown,
    private readonly ownsDevice: boolean,
  ) {
    if (ownsDevice) {
      device.onuncapturederror = (event): undefined => {
        this.fail(event.error.message);
        return undefined;
      };
    }
    device.lost.then((info) => this.fail(`WebGPU device lost: ${info.message}`));
  }

  static async create(canvas: OffscreenCanvas,
    onError: (message: string) => unknown, sharedDevice?: GPUDevice): Promise<WebGpuPresenter> {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const ownsDevice = !sharedDevice;
    let device = sharedDevice;
    if (!device) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No WebGPU adapter is available");
      device = await adapter.requestDevice({ label: "Azahar graphics" });
    }
    const context = canvas.getContext("webgpu");
    if (!context) {
      if (ownsDevice) device.destroy();
      throw new Error("Could not create the WebGPU canvas context");
    }
    try {
      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ label: "Azahar framebuffer presentation", code: shader });
      const pipeline = await device.createRenderPipelineAsync({
        label: "Azahar framebuffer presentation",
        layout: "auto",
        vertex: { module, entryPoint: "vertex" },
        fragment: { module, entryPoint: "fragment", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      context.configure({ device, format, alphaMode: "opaque" });
      return new WebGpuPresenter(canvas, device, context, pipeline, onError, ownsDevice);
    } catch (error) {
      context.unconfigure();
      if (ownsDevice) device.destroy();
      throw error;
    }
  }

  present(bytes: Uint8Array<ArrayBufferLike>, width: number, height: number,
    pitch: number): undefined {
    if (this.#closed) throw new Error("The WebGPU presenter is closed");
    if (this.#failure) throw new Error(this.#failure);
    const limit = this.device.limits.maxTextureDimension2D;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > limit || height > limit || !Number.isInteger(pitch) || pitch < width * 4 ||
      pitch % 4 !== 0 || bytes.byteLength < pitch * (height - 1) + width * 4) {
      throw new Error("Invalid native framebuffer dimensions");
    }
    if (width !== this.#width || height !== this.#height) {
      this.#texture?.destroy();
      this.#texture = this.device.createTexture({
        label: "Azahar native framebuffer",
        size: { width, height },
        format: "bgra8unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.#binding = this.device.createBindGroup({
        label: "Azahar framebuffer binding",
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.#texture.createView() }],
      });
      this.canvas.width = width;
      this.canvas.height = height;
      this.#width = width;
      this.#height = height;
    }
    // writeTexture copies the shared heap before the native video callback returns.
    this.device.queue.writeTexture({ texture: this.#texture! }, bytes.buffer,
      { offset: bytes.byteOffset, bytesPerRow: pitch, rowsPerImage: height }, { width, height });
    const encoder = this.device.createCommandEncoder({ label: "Azahar presentation" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.#binding!);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return undefined;
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    this.#texture?.destroy();
    this.#texture = undefined;
    this.#binding = undefined;
    this.context.unconfigure();
    if (this.ownsDevice) this.device.destroy();
    return undefined;
  }

  screens(frame: ScreenFrame, compositor: GraphicsScreens): undefined {
    if (this.#closed) throw new Error("The WebGPU presenter is closed");
    if (this.#failure) throw new Error(this.#failure);
    const { width, height } = frame;
    const limit = this.device.limits.maxTextureDimension2D;
    if (![width, height].every(Number.isInteger) || width < 1 || height < 1 || width > limit || height > limit) {
      throw new Error("Invalid native presentation dimensions");
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    compositor.render(this.context.getCurrentTexture(), frame);
    return undefined;
  }

  private fail(message: string): undefined {
    if (!this.#closed && !this.#failure) {
      this.#failure = message;
      this.onError(message);
    }
    return undefined;
  }
}
