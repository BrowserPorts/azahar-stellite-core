// SPDX-License-Identifier: GPL-2.0-or-later

import binaryen from "binaryen";
import { foldReadOnlyLoads } from "./fold-readonly-loads.js";

const features = binaryen.Features.MutableGlobals | binaryen.Features.SignExt |
  binaryen.Features.BulkMemory | binaryen.Features.ExceptionHandling |
  binaryen.Features.ReferenceTypes | binaryen.Features.Atomics | binaryen.Features.SIMD128 |
  binaryen.Features.NontrappingFPToInt | binaryen.Features.Multivalue;

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
  readonly #families = new Map<number, Uint8Array<ArrayBuffer>>();
  readonly #entries = new Map<number, CompiledEntry>();
  #imports: WebAssembly.Imports | undefined;
  #table: WebAssembly.Table | undefined;
  #memory: WebAssembly.Memory | undefined;
  #metadata: Metadata | undefined;
  #memoryBase = 0;
  #tableBase = 0;
  readonly #functions: string[];
  readonly #anchorOffset: number;
  readonly #tableAnchorOffset: number;
  compilations = 0;
  optimizations = 0;
  emittedBytes = 0;
  coldBytes = 0;
  optimizedBytes = 0;
  foldedLoads = 0;

  constructor(readonly templates: Uint8Array<ArrayBuffer>, readonly onCompile?: (count: number) => unknown) {
    const module = binaryen.readBinary(templates);
    try {
      const anchor = binaryen.getExportInfo(module.getExport("azahar_dsp_template_anchor"));
      const initializer = binaryen.getExpressionInfo(binaryen.getGlobalInfo(module.getGlobal(anchor.value)).init);
      if (initializer.id !== binaryen.ConstId || initializer.type !== binaryen.i32) {
        throw new Error("DSP template data anchor is not a constant");
      }
      this.#anchorOffset = (initializer as binaryen.ConstInfo).value as number;
      const tableAnchor = binaryen.getExportInfo(module.getExport("azahar_dsp_template_table_anchor"));
      if (module.getNumElementSegments() !== 1) throw new Error("DSP templates require one function segment");
      const segment = binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(0));
      this.#functions = segment.data;
      this.#tableAnchorOffset = segment.data.indexOf(tableAnchor.value);
      if (this.#tableAnchorOffset < 0) throw new Error("DSP template table anchor is absent");
      if (module.getMemoryInfo().base !== "memory") {
        throw new Error("Unexpected DSP template memory import");
      }
    } finally { module.dispose(); }
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
    this.#memoryBase = metadata.anchor - this.#anchorOffset;
    this.#tableBase = metadata.tableAnchor - this.#tableAnchorOffset;
    this.#memory = memory;
    this.#table = table;
    this.#imports = imports;
    for (let opcode = 0; opcode < 65536; ++opcode) {
      const matches = metadata.templates.filter((pattern) =>
        (opcode & pattern[1]) === pattern[2] &&
        pattern[5].every(([mask, rejected]) => (opcode & mask) !== rejected));
      if (matches.length > 1) throw new Error(`Ambiguous DSP opcode ${opcode.toString(16)}`);
      this.#patterns[opcode] = matches[0];
    }
    return this.expansions();
  }

  private expansions(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#patterns, (pattern) => pattern ? (pattern[3] ? 2 : 1) : 0);
  }

  private family(pattern: Pattern): Uint8Array<ArrayBuffer> {
    const slot = pattern[4];
    const cached = this.#families.get(slot);
    if (cached) return cached;
    const target = this.#functions[slot - this.#tableBase];
    if (!target || !this.#memory) throw new Error("DSP opcode body is unavailable");
    const module = binaryen.readBinary(this.templates);
    try {
      module.setFeatures(features);
      while (module.getNumExports()) {
        module.removeExport(binaryen.getExportInfo(module.getExportByIndex(0)).name);
      }
      while (module.getNumElementSegments()) {
        module.removeElementSegment(binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(0)).name);
      }
      const shared = this.#memory.buffer instanceof SharedArrayBuffer;
      if (module.getMemoryInfo().shared !== shared) throw new Error("DSP template memory sharing mismatch");
      // Donor data already resides in the core. New blocks must not initialize it again.
      module.runPasses(["remove-memory-init"]);
      for (let i = module.getNumGlobals() - 1; i >= 0; --i) {
        const global = binaryen.getGlobalInfo(module.getGlobalByIndex(i));
        const base = global.base === "__memory_base" ? this.#memoryBase :
          global.base === "__table_base" ? this.#tableBase : undefined;
        if (base === undefined) continue;
        module.removeGlobal(global.name);
        module.addGlobal(global.name, binaryen.i32, false, module.i32.const(base));
      }
      module.addFunctionExport(target, "template");
      binaryen.setOptimizeLevel(3);
      binaryen.setAlwaysInlineMaxSize(200000);
      module.runPasses(["remove-unused-module-elements", "inlining-optimizing",
        "simplify-globals", "remove-unused-module-elements"]);
      const bytes = module.emitBinary() as Uint8Array<ArrayBuffer>;
      this.#families.set(slot, bytes);
      return bytes;
    } finally { module.dispose(); }
  }

  compile(opcode: number, expansion: number, optimized = false): number {
    if (!this.#imports || !this.#table || !this.#memory) throw new Error("DSP compiler is not bound to the core");
    const pattern = this.#patterns[opcode];
    if (!pattern) throw new Error(`Unimplemented DSP opcode ${opcode.toString(16)}`);
    const key = (opcode * 65536 + (pattern[3] ? expansion : 0)) >>> 0;
    const cached = this.#entries.get(key);
    if (cached && (!optimized || cached.optimized)) return cached.slot;
    const module = binaryen.readBinary(this.family(pattern));
    try {
      module.setFeatures(features);
      const target = binaryen.getExportInfo(module.getExport("template")).value;
      module.removeExport("template");
      module.addFunction("run", binaryen.i32, binaryen.none, [], module.call(target, [
        module.local.get(0, binaryen.i32), module.i32.const(opcode), module.i32.const(expansion),
      ], binaryen.none));
      module.addFunctionExport("run", "run");
      module.runPasses(["inlining", "precompute-propagate", "dce", "vacuum",
        "remove-unused-module-elements"]);
      if (optimized && pattern[6].length) {
        let folded;
        do {
          folded = foldReadOnlyLoads(module, new Uint8Array(this.#memory.buffer), pattern[6]);
          this.foldedLoads += folded;
          if (folded) module.runPasses(["precompute-propagate", "dce", "vacuum"]);
        } while (folded);
      }
      if (optimized) {
        module.runPasses(["simplify-locals-nostructure", "precompute-propagate", "merge-blocks",
          "remove-unused-brs", "vacuum", "coalesce-locals", "remove-unused-module-elements"]);
      }
      const bytes = module.emitBinary() as Uint8Array<ArrayBuffer>;
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
    } finally { module.dispose(); }
  }
}
