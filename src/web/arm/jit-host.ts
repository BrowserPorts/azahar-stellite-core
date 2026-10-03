// SPDX-License-Identifier: GPL-2.0-or-later

import { lowerArm } from "./lower";
import type { MemoryOptions } from "./lower";
import type { ArmBlock } from "./ir";

export interface ArmJitStatistics {
  compiledBlocks: number;
  generatedBytes: number;
  /** Wall time in IR decoding, Wasm lowering, compilation, and installation. */
  compileMs: number;
  liveBlocks: number;
}

/** Synchronous baseline installation; execution stays within the shared Wasm table. */
export class ArmJitHost {
  readonly #free: number[] = [];
  readonly #live = new Set<number>();
  #compiledBlocks = 0;
  #generatedBytes = 0;
  #compileMs = 0;

  compile(json: string, layout: Uint32Array, memory: WebAssembly.Memory,
    table: WebAssembly.Table, helpers: WebAssembly.ModuleImports,
    memoryOptions?: MemoryOptions): { slot: number; bytes: number } {
    const started = performance.now();
    const block = JSON.parse(json) as ArmBlock;
    const [registers, cpsr, extendedRegisters, fpscr, checkBit, executionAbi] = layout;
    if ((layout.length !== 5 && layout.length !== 6) || registers === undefined || cpsr === undefined ||
      extendedRegisters === undefined || fpscr === undefined || checkBit === undefined) {
      throw new Error("Invalid ARM JIT state layout");
    }
    if (layout.length === 6 ? executionAbi !== 2 || !block.sourceCell : Boolean(block.sourceCell)) {
      throw new Error("ARM execution ABI does not match the Wasm compiler");
    }
    const bytes = lowerArm(block, {
      layout: { registers, cpsr, extendedRegisters, fpscr, checkBit },
      shared: memory.buffer instanceof SharedArrayBuffer,
      maximumPages: 65536,
      helperNames: new Set(Object.keys(helpers)),
      ...(memoryOptions ? { memory: memoryOptions } : {}),
    });
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {
      env: { memory, __indirect_function_table: table }, core: helpers,
    });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("ARM region is missing its Wasm entry");
    if (table.length === 0) table.grow(1);
    const slot = this.#free.pop() ?? table.grow(1);
    try { table.set(slot, run); }
    catch (error) { this.#free.push(slot); throw error; }
    this.#live.add(slot);
    this.#compiledBlocks++;
    this.#generatedBytes += bytes.byteLength;
    this.#compileMs += performance.now() - started;
    return { slot, bytes: bytes.byteLength };
  }

  /** Reset interval counters while retaining the current cache population. */
  takeStatistics(): ArmJitStatistics {
    const stats = { compiledBlocks: this.#compiledBlocks, generatedBytes: this.#generatedBytes,
      compileMs: this.#compileMs, liveBlocks: this.#live.size };
    this.#compiledBlocks = 0;
    this.#generatedBytes = 0;
    this.#compileMs = 0;
    return stats;
  }

  release(slot: number, table: WebAssembly.Table): undefined {
    if (!this.#live.delete(slot)) throw new Error("ARM region was already released");
    table.set(slot, null);
    this.#free.push(slot);
    return undefined;
  }
}
