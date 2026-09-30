// SPDX-License-Identifier: GPL-2.0-or-later

import { lowerArm } from "./lower";
import type { MemoryOptions } from "./lower";
import type { ArmBlock } from "./ir";

/** Synchronous baseline installation; execution stays within the shared Wasm table. */
export class ArmJitHost {
  readonly #free: number[] = [];
  readonly #live = new Set<number>();

  compile(json: string, layout: Uint32Array, memory: WebAssembly.Memory,
    table: WebAssembly.Table, helpers: WebAssembly.ModuleImports,
    memoryOptions?: MemoryOptions): { slot: number; bytes: number } {
    const [registers, cpsr, extendedRegisters, fpscr, checkBit] = layout;
    if (layout.length !== 5 || registers === undefined || cpsr === undefined ||
      extendedRegisters === undefined || fpscr === undefined || checkBit === undefined) {
      throw new Error("Invalid ARM JIT state layout");
    }
    const bytes = lowerArm(JSON.parse(json) as ArmBlock, {
      layout: { registers, cpsr, extendedRegisters, fpscr, checkBit },
      shared: memory.buffer instanceof SharedArrayBuffer,
      maximumPages: 65536,
      helperNames: new Set(Object.keys(helpers)),
      ...(memoryOptions ? { memory: memoryOptions } : {}),
    });
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, { env: { memory }, core: helpers });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("ARM region is missing its Wasm entry");
    if (table.length === 0) table.grow(1);
    const slot = this.#free.pop() ?? table.grow(1);
    try { table.set(slot, run); }
    catch (error) { this.#free.push(slot); throw error; }
    this.#live.add(slot);
    return { slot, bytes: bytes.byteLength };
  }

  release(slot: number, table: WebAssembly.Table): undefined {
    if (!this.#live.delete(slot)) throw new Error("ARM region was already released");
    table.set(slot, null);
    this.#free.push(slot);
    return undefined;
  }
}
