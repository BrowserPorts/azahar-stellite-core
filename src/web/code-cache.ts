// SPDX-License-Identifier: GPL-2.0-or-later

import { JitError } from "./protocol";
import type { CodeDependency, CompiledRegion, Engine, Tier } from "./protocol";

export interface RegionIdentity {
  engine: Engine;
  pc: number;
  mode: number;
}

interface InstalledRegion {
  slot: number;
  entries: string[];
  dependencies: CodeDependency[];
  generatedBytes: number;
  tier: Tier;
  used: number;
  instance: WebAssembly.Instance;
}

export interface CacheOptions {
  memory: WebAssembly.Memory;
  table: WebAssembly.Table;
  helpers: WebAssembly.ModuleImports;
  generation: (engine: Engine, address: number) => number;
  maximumBytes?: number;
  maximumSlots?: number;
}

function key(identity: RegionIdentity): string {
  return `${identity.engine}:${identity.mode >>> 0}:${identity.pc >>> 0}`;
}

/** Installation and retirement belong to the emulation worker's dispatch boundary. */
export class CodeCache {
  readonly #entries = new Map<string, InstalledRegion>();
  readonly #regions = new Map<number, InstalledRegion>();
  readonly #freeSlots: number[] = [];
  readonly #retired = new Set<InstalledRegion>();
  readonly #maximumBytes: number;
  readonly #maximumSlots: number;
  #allocatedSlots = 0;
  #bytes = 0;
  #clock = 0;
  #executionDepth = 0;

  constructor(readonly options: CacheOptions) {
    this.#maximumBytes = options.maximumBytes ?? 64 * 1024 * 1024;
    this.#maximumSlots = options.maximumSlots ?? 65536;
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes <= 0 ||
      !Number.isInteger(this.#maximumSlots) || this.#maximumSlots <= 0) {
      throw new RangeError("Invalid JIT cache limits");
    }
  }

  get generatedBytes(): number { return this.#bytes; }
  get regionCount(): number { return this.#regions.size; }

  #current(engine: Engine, dependencies: CodeDependency[]): boolean {
    return dependencies.every((dependency) =>
      this.options.generation(engine, dependency.address) === dependency.generation);
  }

  lookup(identity: RegionIdentity): number | undefined {
    const region = this.#entries.get(key(identity));
    if (!region) return undefined;
    if (!this.#current(identity.engine, region.dependencies)) {
      this.#retire(region);
      return undefined;
    }
    region.used = ++this.#clock;
    return region.slot;
  }

  tier(identity: RegionIdentity): Tier | undefined {
    if (this.lookup(identity) === undefined) return undefined;
    return this.#entries.get(key(identity))?.tier;
  }

  install(identity: RegionIdentity, tier: Tier, compiled: CompiledRegion): number {
    if (this.#executionDepth !== 0) {
      throw new JitError("protocol", "Code installation requires an emulation safe point");
    }
    if (!this.#current(identity.engine, compiled.dependencies)) {
      throw new JitError("stale", "Guest code changed while its region was compiling");
    }
    if (compiled.entries.length !== 1 || compiled.entries[0] !== identity.pc) {
      throw new JitError("protocol", "The current JIT module ABI requires one entry point");
    }
    if (!Number.isInteger(compiled.generatedBytes) || compiled.generatedBytes <= 0 ||
      compiled.generatedBytes > this.#maximumBytes) {
      throw new JitError("capacity", "Compiled region exceeds the JIT cache budget");
    }
    for (const item of WebAssembly.Module.imports(compiled.module)) {
      if (!((item.module === "env" && item.name === "memory" && item.kind === "memory") ||
        (item.module === "env" && item.name === "__indirect_function_table" && item.kind === "table") ||
        (item.module === "core" && item.kind === "function" &&
          typeof this.options.helpers[item.name] === "function"))) {
        throw new JitError("protocol", `Unexpected generated-code import ${item.module}.${item.name}`);
      }
    }
    const instance = new WebAssembly.Instance(compiled.module, {
      env: { memory: this.options.memory, __indirect_function_table: this.options.table },
      core: this.options.helpers,
    });
    const run = instance.exports.run;
    if (typeof run !== "function") {
      throw new JitError("protocol", "Generated code has no callable run export");
    }
    // A late baseline result must not replace an already installed optimized region.
    const existing = this.#entries.get(key(identity));
    if (existing && existing.tier > tier && this.#current(identity.engine, existing.dependencies)) {
      return existing.slot;
    }
    const replacements = new Set<InstalledRegion>();
    for (const pc of compiled.entries) {
      const replaced = this.#entries.get(key({ ...identity, pc }));
      if (replaced) replacements.add(replaced);
    }
    let reclaimedBytes = [...replacements].reduce((total, region) => total + region.generatedBytes, 0);
    while (this.#bytes - reclaimedBytes + compiled.generatedBytes > this.#maximumBytes ||
      (replacements.size === 0 && this.#freeSlots.length === 0 && this.#allocatedSlots >= this.#maximumSlots)) {
      let oldest: InstalledRegion | undefined;
      for (const region of this.#regions.values()) {
        if (!replacements.has(region) && (!oldest || region.used < oldest.used)) oldest = region;
      }
      if (!oldest) throw new JitError("capacity", "The JIT function table is full");
      replacements.add(oldest);
      reclaimedBytes += oldest.generatedBytes;
    }
    const freeSlot = this.#freeSlots.at(-1);
    let slot = freeSlot ?? [...replacements][0]?.slot;
    let grew = false;
    if (slot === undefined) {
      // Slot zero is reserved for null function pointers in the libretro core.
      if (this.options.table.length === 0) this.options.table.grow(1);
      slot = this.options.table.grow(1);
      ++this.#allocatedSlots;
      grew = true;
    }
    try {
      this.options.table.set(slot, run);
    } catch (error) {
      if (grew) this.#freeSlots.push(slot);
      throw error;
    }
    if (freeSlot !== undefined) this.#freeSlots.pop();
    // Retire old code after the table accepts its replacement.
    for (const replaced of replacements) this.#retire(replaced, slot);
    const region: InstalledRegion = {
      slot,
      entries: [...compiled.entries].map((pc) => key({ ...identity, pc })),
      dependencies: compiled.dependencies.map((dependency) => ({ ...dependency })),
      generatedBytes: compiled.generatedBytes,
      tier,
      used: ++this.#clock,
      instance,
    };
    this.#regions.set(slot, region);
    this.#bytes += region.generatedBytes;
    for (const entry of region.entries) this.#entries.set(entry, region);
    return slot;
  }

  enterExecution(): undefined {
    ++this.#executionDepth;
    return undefined;
  }

  leaveExecution(): undefined {
    if (this.#executionDepth === 0) throw new JitError("protocol", "Unbalanced JIT execution scope");
    if (--this.#executionDepth === 0) {
      for (const region of this.#retired) this.#release(region);
      this.#retired.clear();
    }
    return undefined;
  }

  invalidate(engine: Engine, address: number): undefined {
    for (const [entry, region] of this.#entries) {
      if (entry.startsWith(`${engine}:`) && region.dependencies.some((item) => item.address === address)) {
        this.#retire(region);
      }
    }
    return undefined;
  }

  clear(): undefined {
    for (const region of this.#regions.values()) this.#retire(region);
    return undefined;
  }

  #retire(region: InstalledRegion, replacementSlot?: number): undefined {
    if (this.#retired.has(region) || !this.#regions.has(region.slot)) return undefined;
    for (const entry of region.entries) {
      if (this.#entries.get(entry) === region) this.#entries.delete(entry);
    }
    if (this.#executionDepth > 0) this.#retired.add(region);
    else this.#release(region, replacementSlot);
    return undefined;
  }

  #release(region: InstalledRegion, replacementSlot?: number): undefined {
    if (region.slot !== replacementSlot) {
      this.options.table.set(region.slot, null);
      this.#freeSlots.push(region.slot);
    }
    this.#regions.delete(region.slot);
    this.#bytes -= region.generatedBytes;
    return undefined;
  }
}
