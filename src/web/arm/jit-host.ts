// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmConstants, lowerArm, lowerArmRegion } from "./lower";
import type { LowerOptions, MemoryOptions } from "./lower";
import type { ArmBlock, Terminal } from "./ir";

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
  optimizedRegions: number;
  /** Available in builds configured with AZAHAR_ARM_JIT_STATISTICS. */
  execution?: ArmExecutionStatistics;
  /** Cached blocks ranked by guest cycles, when block profiling is enabled. */
  hotBlocks?: ArmBlockProfile[];
}

export interface ArmBlockProfile {
  pc: number;
  cpsr: number;
  fpscr: number;
  /** Body entries since the previous snapshot or this entry's compilation. */
  executions: number;
  /** Static guest cycle estimate for body entries, excluding failed conditions. */
  estimatedCycles: number;
  /** IR operation counts for one execution of this block. */
  operations: Record<string, number>;
}

interface InstalledBlock {
  block: ArmBlock;
  profileBlocks?: readonly ArmBlock[];
  options: LowerOptions;
  memory: WebAssembly.Memory;
  table: WebAssembly.Table;
  helpers: WebAssembly.ModuleImports;
  signature: string;
}

/** Synchronous baseline installation; execution stays within the shared Wasm table. */
export class ArmJitHost {
  readonly #free: number[] = [];
  readonly #live = new Map<number, InstalledBlock>();
  #compiledBlocks = 0;
  #generatedBytes = 0;
  #compileMs = 0;
  #optimizedRegions = 0;
  #profiling = false;
  #lastProfile = new Map<number, bigint>();
  readonly #lowerBlock: typeof lowerArm;

  constructor(lowerBlock: typeof lowerArm = lowerArm) { this.#lowerBlock = lowerBlock; }

  compile(json: string, layout: Uint32Array, memory: WebAssembly.Memory,
    table: WebAssembly.Table, helpers: WebAssembly.ModuleImports,
    memoryOptions?: MemoryOptions, fpStatusHelpers?: ReadonlySet<string>): { slot: number; bytes: number } {
    const started = performance.now();
    const block = JSON.parse(json) as ArmBlock;
    const [registers, cpsr, extendedRegisters, fpscr, checkBit, executionAbi] = layout;
    if ((layout.length !== 5 && layout.length !== 21 && layout.length !== 22) || registers === undefined || cpsr === undefined ||
      extendedRegisters === undefined || fpscr === undefined || checkBit === undefined) {
      throw new Error("Invalid ARM JIT state layout");
    }
    if (layout.length >= 21 ? executionAbi !== 8 || !block.sourceCell : Boolean(block.sourceCell)) {
      throw new Error("ARM execution ABI does not match the Wasm compiler");
    }
    if (layout.length === 22 && layout[21]) {
      block.executionCounter = block.sourceCell! + layout[21];
      this.#profiling = true;
      // A link cell can survive eviction of its original entry. Start this
      // compiled generation at the cell's current total, including address reuse.
      this.#lastProfile.set(block.executionCounter,
        new BigUint64Array(memory.buffer, block.executionCounter, 1)[0]!);
    }
    const options: LowerOptions = {
      layout: { registers, cpsr, extendedRegisters, fpscr, checkBit },
      functionNames: layout.length >= 21 && (layout[11] !== 0 || Boolean(layout[21])),
      ...(layout.length >= 21 ? { execution: {
        halt: layout[6]!, budget: layout[7]!, pendingTicks: layout[8]!,
        sourceUsed: layout[9]!, minimumBudget: layout[10]!, completedBlocks: layout[11]!,
        promotionSource: layout[19]!, promotionRemaining: layout[20]!,
        fastDispatch: {
          pointer: layout[12]!, mask: layout[13]!, strideShift: layout[14]!,
          location: layout[15]!, slot: layout[16]!, minimumBudget: layout[17]!, hits: layout[18]!,
        },
      } } : {}),
      shared: memory.buffer instanceof SharedArrayBuffer,
      maximumPages: 65536,
      helperNames: { has: name => Object.hasOwn(helpers, name) },
      ...(fpStatusHelpers ? { fpStatusHelpers } : {}),
      ...(memoryOptions ? { memory: memoryOptions } : {}),
    };
    const constants = new ArmConstants();
    const bytes = this.#lowerBlock(block, options, constants);
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {
      env: { memory, __indirect_function_table: table }, core: helpers, block: constants.values,
    });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("ARM region is missing its Wasm entry");
    if (table.length === 0) table.grow(1);
    const slot = this.#free.pop() ?? table.grow(1);
    try { table.set(slot, run); }
    catch (error) { this.#free.push(slot); throw error; }
    this.#live.set(slot, { block, options, memory, table, helpers,
      signature: JSON.stringify([options.layout, options.execution, options.memory, options.shared, options.maximumPages]) });
    this.#compiledBlocks++;
    this.#generatedBytes += bytes.byteLength;
    this.#compileMs += performance.now() - started;
    return { slot, bytes: bytes.byteLength };
  }

  /** Replace one native entry with a loop over its cached, dependency-owned blocks. */
  optimize(slots: Uint32Array, links: Uint32Array, maximumBytes: number): number {
    if (!slots.length || slots.length > 8 || links.length !== slots.length * 3) {
      throw new Error("Invalid ARM hot region selection");
    }
    const started = performance.now();
    const root = this.#live.get(slots[0]!);
    if (!root?.options.execution) throw new Error("ARM hot region has no native entry");
    const blocks: ArmBlock[] = [];
    const internal = new Map<number, { index: number; minimumBudget: number }>();
    for (let index = 0; index < slots.length; index++) {
      const record = this.#live.get(slots[index]!);
      if (!record || record.memory !== root.memory || record.table !== root.table ||
        record.helpers !== root.helpers || record.options.fpStatusHelpers !== root.options.fpStatusHelpers ||
        record.signature !== root.signature) return 0;
      const cell = links[index * 3]!;
      const minimumBudget = links[index * 3 + 2]!;
      if (!cell || links[index * 3 + 1] !== index || !minimumBudget) throw new Error("Invalid ARM hot region link");
      blocks.push(record.block);
      internal.set(cell, { index, minimumBudget });
    }
    const hasInternalLink = (terminal: Terminal): boolean => {
      if (terminal.kind === "link") return !!terminal.cell && internal.has(terminal.cell);
      if (terminal.kind === "if" || terminal.kind === "check-bit") {
        return hasInternalLink(terminal.then) || hasInternalLink(terminal.else);
      }
      return terminal.kind === "check-halt" && hasInternalLink(terminal.else);
    };
    if (!blocks.some(block => hasInternalLink(block.terminal) ||
      !!block.conditionFailedCell && internal.has(block.conditionFailedCell))) return 0;
    const bytes = lowerArmRegion(blocks, internal, root.options);
    if (bytes.byteLength > maximumBytes) return 0;
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {
      env: { memory: root.memory, __indirect_function_table: root.table }, core: root.helpers,
    });
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("ARM hot region is missing its Wasm entry");
    root.table.set(slots[0]!, run);
    // Native region ownership retains peer link cells after their original entries retire.
    if (this.#profiling) root.profileBlocks = blocks;
    this.#optimizedRegions++;
    this.#generatedBytes += bytes.byteLength;
    this.#compileMs += performance.now() - started;
    return bytes.byteLength;
  }

  /** Reset interval counters while retaining the current cache population. */
  takeStatistics(): ArmJitStatistics {
    const stats = { compiledBlocks: this.#compiledBlocks, generatedBytes: this.#generatedBytes,
      compileMs: this.#compileMs, liveBlocks: this.#live.size, optimizedRegions: this.#optimizedRegions,
      ...(this.#profiling ? { hotBlocks: this.takeBlockProfile() } : {}) };
    this.#compiledBlocks = 0;
    this.#generatedBytes = 0;
    this.#compileMs = 0;
    this.#optimizedRegions = 0;
    return stats;
  }

  private takeBlockProfile(): ArmBlockProfile[] {
    const blocks = new Map<number, { block: ArmBlock; memory: WebAssembly.Memory }>();
    for (const record of this.#live.values()) for (const block of record.profileBlocks ?? [record.block]) {
      if (block.executionCounter) blocks.set(block.executionCounter, { block, memory: record.memory });
    }
    const views = new Map<WebAssembly.Memory, BigUint64Array>();
    const next = new Map<number, bigint>();
    const counts: { block: ArmBlock; executions: number }[] = [];
    for (const [address, { block, memory }] of blocks) {
      let view = views.get(memory);
      if (!view) { view = new BigUint64Array(memory.buffer); views.set(memory, view); }
      const total = view[address >>> 3]!;
      const executions = Number(BigInt.asUintN(64, total - (this.#lastProfile.get(address) ?? total)));
      next.set(address, total);
      if (executions) counts.push({ block, executions });
    }
    this.#lastProfile = next;
    return counts.sort((a, b) => b.executions * b.block.cycles - a.executions * a.block.cycles)
      .slice(0, 32).map(({ block, executions }) => {
        const operations: Record<string, number> = {};
        for (const node of block.nodes) operations[node.op] = (operations[node.op] ?? 0) + 1;
        return { pc: block.startPc ?? 0, cpsr: block.startCpsr ?? 0, fpscr: block.startFpscr ?? 0,
          executions, estimatedCycles: executions * block.cycles, operations };
      });
  }

  release(slot: number, table: WebAssembly.Table): undefined {
    if (!this.#live.delete(slot)) throw new Error("ARM region was already released");
    table.set(slot, null);
    this.#free.push(slot);
    return undefined;
  }
}
