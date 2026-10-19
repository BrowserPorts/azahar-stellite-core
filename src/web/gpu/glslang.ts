// SPDX-License-Identifier: GPL-2.0-or-later

import type { ShaderCompiler } from "./shader-compiler";
import { wasmAssetOptions } from "../assets";
import type { RuntimeAssets, WasmAssetOptions } from "../assets";

interface GlslangModule {
  HEAPU8: Uint8Array<SharedArrayBuffer>;
  HEAPU32: Uint32Array<SharedArrayBuffer>;
  stringToNewUTF8(source: string): number;
  _malloc(bytes: number): number;
  _free(pointer: number): unknown;
  _convert_glsl_to_spirv(source: number, stage: number, debug: number, version: number,
    output: number, length: number): number;
  _destroy_output_buffer(handle: number): unknown;
}

interface GlslangOptions extends WasmAssetOptions {
  printErr(line: string): unknown;
  onAbort(reason: unknown): unknown;
}

type GlslangFactory = (options: GlslangOptions) => Promise<GlslangModule>;
type ShaderStage = "vertex" | "fragment" | "compute";

/** Uses glslang's original Web ABI, including its output buffer ownership. */
export class GlslangCompiler {
  #module: GlslangModule | undefined;
  #diagnostics: string[] = [];

  private constructor() {}

  static async create(url: URL | string = new URL("./azahar-glslang.mjs", import.meta.url),
    assets?: RuntimeAssets):
    Promise<GlslangCompiler> {
    const compiler = new GlslangCompiler();
    const { default: factory } = await import(String(url)) as { default: GlslangFactory };
    compiler.#module = await factory({
      ...wasmAssetOptions(assets, "azahar-glslang.mjs"),
      printErr: (line) => compiler.#diagnostics.push(line),
      onAbort: (reason) => {
        compiler.#module = undefined;
        compiler.#diagnostics.push(String(reason));
        return undefined;
      },
    });
    return compiler;
  }

  /** Returns an owned copy of the SPIR-V words. */
  compile(source: string, stage: ShaderStage): Uint32Array {
    return this.compileWith(source, stage, (bytes) =>
      new Uint32Array(new Uint8Array(bytes).buffer));
  }

  /** Passes the live SPIR-V view to Naga before releasing glslang's buffer. */
  compileWgsl(source: string, stage: ShaderStage, compiler: ShaderCompiler): string {
    return this.compileWith(source, stage, (bytes) => compiler.compileSpirv(bytes));
  }

  private compileWith<T>(source: string, stage: ShaderStage,
    consume: (bytes: Uint8Array<SharedArrayBuffer>) => T): T {
    const module = this.#module;
    if (!module) throw new Error("The GLSL compiler is closed");
    if (source.includes("\0")) throw new Error("GLSL source contains a null byte");
    this.#diagnostics.length = 0;
    let input = 0;
    let output = 0;
    let handle = 0;
    try {
      try {
        input = module.stringToNewUTF8(source);
        output = module._malloc(8);
        if (!input || !output) throw new Error("GLSL compiler allocation failed");
        // glslang's ABI uses vertex=0, fragment=4 and compute=5, and word counts.
        handle = module._convert_glsl_to_spirv(input,
          stage === "vertex" ? 0 : stage === "fragment" ? 4 : 5,
          0, 0x10000, output, output + 4);
      } catch (error) {
        this.#module = undefined;
        throw new Error(this.#diagnostics.join("\n") || "GLSL compiler stopped", { cause: error });
      }
      if (!handle) throw new Error(`GLSL compilation failed:\n${this.#diagnostics.join("\n")}`);
      // Compilation may grow Wasm memory; read the current views afterwards.
      const pointer = module.HEAPU32[output >>> 2]!;
      const length = module.HEAPU32[(output + 4) >>> 2]! * 4;
      return consume(module.HEAPU8.subarray(pointer, pointer + length));
    } finally {
      if (this.#module) {
        if (handle) module._destroy_output_buffer(handle);
        if (output) module._free(output);
        if (input) module._free(input);
      }
    }
  }

  close(): undefined {
    this.#module = undefined;
    return undefined;
  }
}
