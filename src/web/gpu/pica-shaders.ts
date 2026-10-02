// SPDX-License-Identifier: GPL-2.0-or-later

import { GlslangCompiler } from "./glslang";
import { NativeShaders } from "./native-shaders";
import { ShaderCompiler } from "./shader-compiler";

/** Compiles native PICA configurations and keeps hot fragment programs on the device. */
export class PicaShaders {
  #fragments = new Map<string, Promise<GPUShaderModule>>();
  #closed = false;
  readonly configurationSize: number;
  readonly configurationSchema: bigint;

  private constructor(
    readonly device: GPUDevice,
    readonly vertex: GPUShaderModule,
    private readonly native: NativeShaders,
    private readonly glslang: GlslangCompiler,
    private readonly naga: ShaderCompiler,
  ) {
    this.configurationSize = native.configurationSize;
    this.configurationSchema = native.configurationSchema;
  }

  static async create(device: GPUDevice): Promise<PicaShaders> {
    const results = await Promise.allSettled([
      NativeShaders.create(), GlslangCompiler.create(), ShaderCompiler.create(),
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
      !Number.isInteger(userFlags) || userFlags < 0 || userFlags > 1) {
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
    this.native.close(); this.glslang.close(); this.naga.close();
    return undefined;
  }
}
