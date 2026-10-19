// SPDX-License-Identifier: GPL-2.0-or-later

import { FamilyArchive } from "./family-archive";
import { optimizeDsp } from "./optimizer";

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
  compilations = 0;
  optimizations = 0;
  emittedBytes = 0;
  coldBytes = 0;
  optimizedBytes = 0;
  foldedLoads = 0;

  private constructor(readonly archive: FamilyArchive, readonly onCompile?: (count: number) => unknown) {}

  static async create(templates: Uint8Array<ArrayBuffer>, families: Uint8Array<ArrayBuffer>,
    onCompile?: (count: number) => unknown): Promise<DspJitHost> {
    const archive = new FamilyArchive(families);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", templates));
    const sourceHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sourceHash !== archive.metadata.sourceSha256) {
      throw new Error("DSP family archive does not match the opcode templates");
    }
    return new DspJitHost(archive, onCompile);
  }

  bind(json: string, sizes: number[], memory: WebAssembly.Memory, table: WebAssembly.Table,
    imports: WebAssembly.Imports): Uint8Array<ArrayBuffer> {
    if (this.#metadata) {
      if (this.#memory !== memory || this.#table !== table) {
        throw new Error("DSP compiler is already bound to another core");
      }
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
    return this.expansions();
  }

  private expansions(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#patterns, (pattern) => pattern ? (pattern[3] ? 2 : 1) : 0);
  }

  compile(opcode: number, expansion: number, optimized = false): number {
    if (!this.#imports || !this.#table || !this.#memory) throw new Error("DSP compiler is not bound to the core");
    const pattern = this.#patterns[opcode];
    if (!pattern) throw new Error(`Unimplemented DSP opcode ${opcode.toString(16)}`);
    const key = (opcode * 65536 + (pattern[3] ? expansion : 0)) >>> 0;
    const cached = this.#entries.get(key);
    if (cached && (!optimized || cached.optimized)) return cached.slot;
    let bytes = this.archive.specialize(pattern[4] - this.#tableBase,
      [this.#memoryBase, this.#tableBase, opcode, expansion]);
    if (optimized) {
      const result = optimizeDsp(bytes, new Uint8Array(this.#memory.buffer), pattern[6]);
      bytes = result.bytes;
      this.foldedLoads += result.foldedLoads;
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.#imports);
    const run = instance.exports.run;
    if (typeof run !== "function") throw new Error("DSP block is missing its Wasm entry");
    // Promotion replaces the existing slot so native cached function pointers stay valid.
    const slot = cached?.slot ?? this.#table.grow(1);
    this.#table.set(slot, run);
    this.#entries.set(key, { slot, optimized });
    this.emittedBytes += bytes.byteLength;
    if (optimized) {
      ++this.optimizations;
      this.optimizedBytes += bytes.byteLength;
    } else this.coldBytes += bytes.byteLength;
    if (!cached) {
      ++this.compilations;
      this.onCompile?.(this.compilations);
    }
    return slot;
  }
}
