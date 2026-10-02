// SPDX-License-Identifier: GPL-2.0-or-later

interface CompilerExports {
  memory: WebAssembly.Memory;
  azahar_shader_abi(): number;
  azahar_shader_create(): number;
  azahar_shader_destroy(handle: number): undefined;
  azahar_shader_alloc(length: number): number;
  azahar_shader_free(pointer: number, length: number): undefined;
  azahar_shader_compile(handle: number, pointer: number, length: number, stage: number): number;
  azahar_shader_output(handle: number): number;
  azahar_shader_output_length(handle: number): number;
}

interface CompilerDiagnostic { message?: string }

/** Reuses Naga's GLSL frontend; generated shaders are validated before reaching WebGPU. */
export class ShaderCompiler {
  #handle: number;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder("utf-8", { fatal: true });

  private constructor(readonly exports: CompilerExports, private readonly diagnostic: CompilerDiagnostic) {
    if (exports.azahar_shader_abi() !== 1) throw new Error("Unsupported shader compiler ABI");
    this.#handle = exports.azahar_shader_create();
    if (!this.#handle) throw new Error("Shader compiler allocation failed");
  }

  static async create(url: URL | string = new URL("./azahar-shader-compiler.wasm", import.meta.url)):
    Promise<ShaderCompiler> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Shader compiler download failed: ${response.status}`);
    const diagnostic: CompilerDiagnostic = {};
    const decoder = new TextDecoder();
    let exports: CompilerExports | undefined;
    const { instance } = await WebAssembly.instantiateStreaming(response, {
      azahar: { shader_panic: (pointer: number, length: number): undefined => {
        diagnostic.message = exports ? decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length)) :
          "Shader compiler initialization failed";
        return undefined;
      } },
    });
    exports = instance.exports as unknown as CompilerExports;
    try { return new ShaderCompiler(exports, diagnostic); }
    catch (error) {
      throw new Error(diagnostic.message ?? "Shader compiler initialization failed", { cause: error });
    }
  }

  compile(source: string, stage: "vertex" | "fragment" | "compute"): string {
    if (!this.#handle) throw new Error("The shader compiler is closed");
    const bytes = this.#encoder.encode(source);
    const pointer = this.exports.azahar_shader_alloc(bytes.length);
    if (!pointer) throw new Error("Shader source allocation failed");
    try {
      new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
      let result: number;
      try {
        result = this.exports.azahar_shader_compile(this.#handle, pointer, bytes.length,
          stage === "vertex" ? 0 : stage === "fragment" ? 1 : 2);
      } catch (error) {
        // A native trap can leave Rust's stack and compiler state unusable.
        this.#handle = 0;
        throw new Error(this.diagnostic.message ?? "Shader compiler stopped", { cause: error });
      }
      // Compilation may grow Wasm memory; acquire the output view afterwards.
      const output = this.#decoder.decode(new Uint8Array(this.exports.memory.buffer,
        this.exports.azahar_shader_output(this.#handle),
        this.exports.azahar_shader_output_length(this.#handle)));
      if (!result) throw new Error(`Shader compilation failed:\n${output}`);
      return output;
    } finally {
      if (this.#handle) this.exports.azahar_shader_free(pointer, bytes.length);
    }
  }

  close(): undefined {
    if (this.#handle) this.exports.azahar_shader_destroy(this.#handle);
    this.#handle = 0;
    return undefined;
  }
}
