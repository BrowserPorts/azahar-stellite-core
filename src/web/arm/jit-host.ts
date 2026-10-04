// SPDX-License-Identifier: GPL-2.0-or-later

import { lowerArm } from "./lower";
import type { MemoryOptions } from "./lower";
import type { ArmBlock } from "./ir";

/** Native execution totals since the previous snapshot, when counting is enabled. */
export interface ArmExecutionStatistics {
  nativeDispatches: number;
  completedBlocks: number;
  /** Completed blocks beyond native dispatches, including static and indirect Wasm links. */
  linkedBlocks: number;
  budgetReuses: number;
  /** Native and emitted Wasm dispatch-cache hits. */
  fastDispatchHits: number;
}

export interface ArmJitStatistics {
  compiledBlocks: number;
  generatedBytes: number;
  /** Wall time in IR decoding, Wasm lowering, compilation, and installation. */
  compileMs: number;
  liveBlocks: number;
  /** Available in builds configured with AZAHAR_ARM_JIT_STATISTICS. */
  execution?: ArmExecutionStatistics;
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
    if ((layout.length !== 5 && layout.length !== 20) || registers === undefined || cpsr === undefined ||
      extendedRegisters === undefined || fpscr === undefined || checkBit === undefined) {
      throw new Error("Invalid ARM JIT state layout");
    }
    if (layout.length === 20 ? executionAbi !== 6 || !block.sourceCell : Boolean(block.sourceCell)) {
      throw new Error("ARM execution ABI does not match the Wasm compiler");
    }
    const bytes = lowerArm(block, {
      layout: { registers, cpsr, extendedRegisters, fpscr, checkBit },
      ...(layout.length === 20 ? { execution: {
        halt: layout[6]!, clock: layout[7]!, budget: layout[8]!, pendingTicks: layout[9]!,
        sourceUsed: layout[10]!, minimumBudget: layout[11]!, completedBlocks: layout[12]!,
        fastDispatch: {
          pointer: layout[13]!, mask: layout[14]!, strideShift: layout[15]!,
          location: layout[16]!, slot: layout[17]!, minimumBudget: layout[18]!, hits: layout[19]!,
        },
      } } : {}),
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
