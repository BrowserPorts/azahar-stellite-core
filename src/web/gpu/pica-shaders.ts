// SPDX-License-Identifier: GPL-2.0-or-later

import type { RuntimeAssets } from "../assets";

import { GlslangCompiler } from "./glslang";
import { NativeShaders } from "./native-shaders";
import { ShaderCompiler } from "./shader-compiler";

interface VertexProgram {
  module: GPUShaderModule;
  layout: GPUVertexBufferLayout;
}

/** Compiles native PICA configurations and keeps hot fragment programs on the device. */
export class PicaShaders {
  #fragments = new Map<string, Promise<GPUShaderModule>>();
  #vertices = new Map<number, VertexProgram>();
  #closed = false;
  readonly configurationSize: number;
  readonly configurationSchema: bigint;
  readonly vertexLayout: GPUVertexBufferLayout;

  private constructor(
    readonly device: GPUDevice,
    readonly vertex: GPUShaderModule,
    private readonly native: NativeShaders,
    private readonly glslang: GlslangCompiler,
    private readonly naga: ShaderCompiler,
  ) {
    this.configurationSize = native.configurationSize;
    this.configurationSchema = native.configurationSchema;
    this.vertexLayout = native.vertexLayout;
  }

  static async create(device: GPUDevice, assets?: RuntimeAssets): Promise<PicaShaders> {
    const results = await Promise.allSettled([
      NativeShaders.create(assets?.["azahar-pica-shaders.mjs"], assets),
      GlslangCompiler.create(assets?.["azahar-glslang.mjs"], assets),
      ShaderCompiler.create(assets?.["azahar-shader-compiler.wasm"]),
    ]);
    const [native, glslang, naga] = results;
    if (native.status !== "fulfilled" || glslang.status !== "fulfilled" || naga.status !== "fulfilled") {
      for (const result of results) if (result.status === "fulfilled") result.value.close();
      throw native.status === "rejected" ? native.reason :
        glslang.status === "rejected" ? glslang.reason : (naga as PromiseRejectedResult).reason;
    }
    try {
      const code = glslang.value.compileWgsl(native.value.vertex(), "vertex", naga.value);
      const vertex = await PicaShaders.createModule(device, "Azahar PICA vertex shader", code);
      return new PicaShaders(device, vertex, native.value, glslang.value, naga.value);
    } catch (error) {
      native.value.close(); glslang.value.close(); naga.value.close();
      throw error;
    }
  }

  fragment(configuration: Uint8Array<ArrayBufferLike>, userFlags = 0): Promise<GPUShaderModule> {
    if (this.#closed) throw new Error("The PICA shader compiler is closed");
    if (configuration.byteLength !== this.configurationSize ||
      !Number.isInteger(userFlags) || userFlags < 0 || userFlags > 41 || (userFlags & 15) > 9) {
      throw new Error("Invalid PICA shader configuration");
    }
    // The complete bytes are the key, so hash collisions cannot select another program.
    const key = String.fromCharCode(...configuration, userFlags);
    const cached = this.#fragments.get(key);
    if (cached) {
      this.#fragments.delete(key);
      this.#fragments.set(key, cached);
      return cached;
    }
    const source = this.native.fragment(configuration, userFlags);
    const code = this.glslang.compileWgsl(source, "fragment", this.naga);
    const pending = PicaShaders.createModule(this.device, "Azahar PICA fragment shader", code)
      .then((module) => {
        if (this.#closed) throw new Error("The PICA shader compiler is closed");
        return module;
      }).catch((error) => {
        if (this.#fragments.get(key) === pending) this.#fragments.delete(key);
        throw error;
      });
    if (this.#fragments.size >= 512) this.#fragments.delete(this.#fragments.keys().next().value!);
    this.#fragments.set(key, pending);
    return pending;
  }

  async createVertexProgram(handle: number, source: string, inputMask: number): Promise<undefined> {
    if (this.#closed || !Number.isInteger(handle) || handle <= 0 || this.#vertices.has(handle)) {
      throw new Error("Invalid PICA vertex program handle");
    }
    if (!Number.isInteger(inputMask) || inputMask <= 0 || inputMask > 0xffff) {
      throw new Error("Invalid PICA input register mask");
    }
    const attributes: GPUVertexAttribute[] = [];
    for (let shaderLocation = 0; shaderLocation < 16; shaderLocation++) {
      if (inputMask & (1 << shaderLocation)) {
        attributes.push({ shaderLocation, offset: attributes.length * 16, format: "float32x4" });
      }
    }
    const code = this.glslang.compileWgsl(source, "vertex", this.naga);
    const module = await PicaShaders.createModule(this.device, "Azahar programmable PICA vertex shader", code);
    if (this.#closed) throw new Error("The PICA shader compiler is closed");
    this.#vertices.set(handle, { module, layout: { arrayStride: attributes.length * 16, attributes } });
    return undefined;
  }

  vertexProgram(handle: number): VertexProgram {
    const program = this.#vertices.get(handle);
    if (!program) throw new Error("Unknown PICA vertex program");
    return program;
  }

  destroyVertexProgram(handle: number): undefined {
    if (!this.#vertices.delete(handle)) throw new Error("Unknown PICA vertex program");
    return undefined;
  }

  private static async createModule(device: GPUDevice, label: string, code: string): Promise<GPUShaderModule> {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length) throw new Error(`${label} failed:\n` +
      errors.map((message) => `${message.lineNum}:${message.linePos}: ${message.message}`).join("\n"));
    return module;
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    this.#fragments.clear();
    this.#vertices.clear();
    this.native.close(); this.glslang.close(); this.naga.close();
    return undefined;
  }
}
