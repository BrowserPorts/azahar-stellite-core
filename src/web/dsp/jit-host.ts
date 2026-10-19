// SPDX-License-Identifier: GPL-2.0-or-later

import { FamilyArchive } from "./family-archive";
import { prepareDspOptimizer, type DspOptimizer, type OptimizerAssets } from "./optimizer-client";
import type { OptimizerSignal } from "./optimizer-mailbox";

type Pattern = [string, number, number, boolean, number, [number, number][], [number, number][]];
interface Metadata {
  abi: number;
  anchor: number;
  tableAnchor: number;
  registerSize: number;
  semanticsSize: number;
  memorySize: number;
  templates: Pattern[];
}
interface CompiledEntry {
  slot: number;
  optimized: boolean;
  pending: boolean;
}

/** Specializes the upstream compiled opcode bodies into executable Wasm. */
export class DspJitHost {
  readonly #patterns: (Pattern | undefined)[] = new Array(65536);
  readonly #entries = new Map<number, CompiledEntry>();
  #imports: WebAssembly.Imports | undefined;
  #table: WebAssembly.Table | undefined;
  #memory: WebAssembly.Memory | undefined;
  #metadata: Metadata | undefined;
  #memoryBase = 0;
  #tableBase = 0;
  #optimizer: DspOptimizer | undefined;
  #completedOptimizations = 0;
  #optimizationMs = 0;
  #ready: Int32Array<SharedArrayBuffer> | undefined;
  readyPointer = 0;
  compilations = 0;
  optimizations = 0;
  emittedBytes = 0;
  coldBytes = 0;
  optimizedBytes = 0;
  foldedLoads = 0;

  private constructor(readonly archive: FamilyArchive,
    readonly createOptimizer: (memory: SharedArrayBuffer, signal: OptimizerSignal) => Promise<DspOptimizer>,
    readonly onCompile?: (count: number) => unknown) {}

  static async create(templates: Uint8Array<ArrayBuffer>, families: Uint8Array<ArrayBuffer>,
    assets: OptimizerAssets, onCompile?: (count: number) => unknown): Promise<DspJitHost> {
    const archive = new FamilyArchive(families);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", templates));
    const sourceHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sourceHash !== archive.metadata.sourceSha256) {
      throw new Error("DSP family archive does not match the opcode templates");
    }
    return new DspJitHost(archive, await prepareDspOptimizer(assets), onCompile);
  }

  async bind(json: string, sizes: number[], memory: WebAssembly.Memory, table: WebAssembly.Table,
    imports: WebAssembly.Imports): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#metadata) {
      if (this.#memory !== memory || this.#table !== table) {
        throw new Error("DSP compiler is already bound to another core");
      }
      await this.startOptimizer(memory);
      return this.expansions();
    }
    const metadata = JSON.parse(json) as Metadata;
    if (metadata.abi !== 2 || sizes[0] !== metadata.registerSize ||
      sizes[1] !== metadata.semanticsSize || sizes[2] !== metadata.memorySize) {
      throw new Error("DSP template ABI does not match the execution backend");
    }
    this.#metadata = metadata;
    this.#memoryBase = metadata.anchor - this.archive.metadata.anchorOffset;
    this.#tableBase = metadata.tableAnchor - this.archive.metadata.tableAnchorOffset;
    if (this.archive.metadata.shared !== (memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error("DSP template memory sharing mismatch");
    }
    this.#memory = memory;
    this.#table = table;
    this.#imports = imports;
    for (const pattern of metadata.templates) {
      const variableBits = ~pattern[1] & 0xffff;
      let operands = 0;
      do {
        const opcode = pattern[2] | operands;
        if (pattern[5].every(([mask, rejected]) => (opcode & mask) !== rejected)) {
          if (this.#patterns[opcode]) throw new Error(`Ambiguous DSP opcode ${opcode.toString(16)}`);
          this.#patterns[opcode] = pattern;
        }
        // Visit each subset of the operand bits, keeping the fixed opcode bits intact.
        operands = (operands - variableBits) & variableBits;
      } while (operands !== 0);
    }
    await this.startOptimizer(memory);
    return this.expansions();
  }

  private async startOptimizer(memory: WebAssembly.Memory): Promise<undefined> {
    if (!(memory.buffer instanceof SharedArrayBuffer)) throw new Error("DSP background optimization requires shared memory");
    if (!this.#ready) {
      const allocate = this.#imports?.env?.malloc;
      if (typeof allocate !== "function") throw new Error("DSP native allocator is unavailable");
      this.readyPointer = Number(allocate(4));
      if (!this.readyPointer) throw new Error("Could not allocate the DSP optimization signal");
      // This word shares the compiler host's core lifetime, including pooled pthread reuse.
      this.#ready = new Int32Array(memory.buffer, this.readyPointer, 1);
    }
    if (!this.#optimizer) {
      Atomics.store(this.#ready, 0, 0);
      this.#optimizer = await this.createOptimizer(memory.buffer, {
        memory: memory.buffer, offset: this.readyPointer,
      });
    }
    return undefined;
  }

  private expansions(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#patterns, (pattern) => pattern ? (pattern[3] ? 2 : 1) : 0);
  }

  compile(opcode: number, expansion: number): number {
    if (!this.#imports || !this.#table || !this.#memory) throw new Error("DSP compiler is not bound to the core");
    const pattern = this.#patterns[opcode];
    if (!pattern) throw new Error(`Unimplemented DSP opcode ${opcode.toString(16)}`);
    const key = (opcode * 65536 + (pattern[3] ? expansion : 0)) >>> 0;
    const cached = this.#entries.get(key);
    if (cached) return cached.slot;
    const bytes = this.archive.specialize(pattern[4] - this.#tableBase,
      [this.#memoryBase, this.#tableBase, opcode, expansion]);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.#imports);
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("DSP block is missing its Wasm entry");
    const slot = this.#table.grow(1);
    this.#table.set(slot, run);
    this.#entries.set(key, { slot, optimized: false, pending: false });
    this.emittedBytes += bytes.byteLength;
    this.coldBytes += bytes.byteLength;
    ++this.compilations;
    this.onCompile?.(this.compilations);
    return slot;
  }

  requestOptimization(opcode: number, expansion: number): CompiledEntry {
    this.compile(opcode, expansion);
    const pattern = this.#patterns[opcode]!;
    const key = (opcode * 65536 + (pattern[3] ? expansion : 0)) >>> 0;
    const entry = this.#entries.get(key)!;
    if (entry.optimized) {
      ++this.#completedOptimizations;
      Atomics.store(this.#ready!, 0, 1);
      return entry;
    }
    if (entry.pending) return entry;
    if (!this.#optimizer) throw new Error("DSP optimizer is closed");
    this.#optimizer.check();
    const bytes = this.archive.specialize(pattern[4] - this.#tableBase,
      [this.#memoryBase, this.#tableBase, opcode, expansion]);
    this.#optimizer.request(key, bytes, pattern[6]);
    entry.pending = true;
    return entry;
  }

  /** Forced hot configurations execute the optimized entry before returning to native code. */
  async optimize(opcode: number, expansion: number): Promise<number> {
    const entry = this.requestOptimization(opcode, expansion);
    while (!entry.optimized) {
      const optimizer = this.#optimizer!;
      const sequence = optimizer.mailbox.sequence;
      this.drain();
      if (!entry.optimized) await optimizer.mailbox.wait(sequence);
    }
    return entry.slot;
  }

  /** Install completed code on its owning table without depending on message dispatch. */
  private drain(): undefined {
    const optimizer = this.#optimizer;
    if (!optimizer) return undefined;
    const deadline = performance.now() + 1;
    do {
      const result = optimizer.mailbox.read();
      if (!result) break;
      if (result.error) throw new Error(`DSP optimization ${result.key.toString(16)}: ${new TextDecoder().decode(result.bytes)}`);
      const entry = this.#entries.get(result.key);
      if (!entry?.pending) throw new Error("DSP optimization has no pending native entry");
      const started = performance.now();
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.bytes), this.#imports!);
      const run = instance.exports.run;
      if (typeof run !== "function") throw new Error("Optimized DSP block is missing its Wasm entry");
      // Replace the existing slot so native cached function pointers remain valid.
      this.#table!.set(entry.slot, run);
      entry.optimized = true;
      entry.pending = false;
      this.foldedLoads += result.foldedLoads;
      this.optimizedBytes += result.bytes.byteLength;
      this.emittedBytes += result.bytes.byteLength;
      ++this.optimizations;
      ++this.#completedOptimizations;
      this.#optimizationMs += result.elapsedMs + performance.now() - started;
    } while (optimizer.mailbox.failed || performance.now() < deadline);
    optimizer.check();
    return undefined;
  }

  takeOptimizations(): { count: number; elapsedMs: number } | undefined {
    // Clear before reading: a concurrently published result can then rearm the word.
    if (this.#ready) Atomics.store(this.#ready, 0, 0);
    this.drain();
    if (this.#optimizer?.mailbox.hasResults || this.#optimizer?.mailbox.failed) {
      Atomics.store(this.#ready!, 0, 1);
    }
    if (!this.#completedOptimizations) return undefined;
    const result = { count: this.#completedOptimizations, elapsedMs: this.#optimizationMs };
    this.#completedOptimizations = 0;
    this.#optimizationMs = 0;
    return result;
  }

  stopOptimization(): undefined {
    this.#optimizer?.close();
    this.#optimizer = undefined;
    for (const entry of this.#entries.values()) entry.pending = false;
    return undefined;
  }
}
