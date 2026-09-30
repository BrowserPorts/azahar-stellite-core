// SPDX-License-Identifier: GPL-2.0-or-later

import { lowerPica } from "./lower";

/** Shader execution uses a raw Wasm table entry and shares the emulator heap. */
export class PicaJitHost {
  readonly #free: number[] = [];
  readonly #live = new Set<number>();

  constructor(readonly dispatch = false) {}

  compile(program: Uint32Array, swizzles: Uint32Array, entry: number, layout: Uint32Array,
    memory: WebAssembly.Memory, table: WebAssembly.Table,
    helpers: WebAssembly.ModuleImports): { slot: number; bytes: number } {
    const [floatUniforms, boolUniforms, intUniforms, input, temporary, output,
      outputBank, addressRegisters, conditionalCode] = layout;
    if (layout.length !== 9 || floatUniforms === undefined || boolUniforms === undefined ||
      intUniforms === undefined || input === undefined || temporary === undefined ||
      output === undefined || outputBank === undefined || addressRegisters === undefined ||
      conditionalCode === undefined) throw new Error("Invalid PICA shader state layout");
    const bytes = lowerPica(program, swizzles, entry, {
      layout: { floatUniforms, boolUniforms, intUniforms, input, temporary, output,
        outputBank, addressRegisters, conditionalCode },
      shared: memory.buffer instanceof SharedArrayBuffer, maximumPages: 65536,
      dispatch: this.dispatch,
    });
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, { env: { memory }, core: helpers });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("PICA shader is missing its Wasm entry");
    if (!table.length) table.grow(1);
    const slot = this.#free.pop() ?? table.grow(1);
    try { table.set(slot, run); }
    catch (error) { this.#free.push(slot); throw error; }
    this.#live.add(slot);
    return { slot, bytes: bytes.byteLength };
  }

  release(slot: number, table: WebAssembly.Table): undefined {
    if (!this.#live.delete(slot)) throw new Error("PICA shader was already released");
    table.set(slot, null);
    this.#free.push(slot);
    return undefined;
  }
}
