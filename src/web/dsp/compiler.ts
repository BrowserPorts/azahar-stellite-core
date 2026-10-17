// SPDX-License-Identifier: GPL-2.0-or-later

import binaryen from "binaryen";

export const features = binaryen.Features.MutableGlobals | binaryen.Features.SignExt |
  binaryen.Features.BulkMemory | binaryen.Features.BulkMemoryOpt | binaryen.Features.ExceptionHandling |
  binaryen.Features.ReferenceTypes | binaryen.Features.Atomics | binaryen.Features.SIMD128 |
  binaryen.Features.NontrappingFPToInt | binaryen.Features.Multivalue;

export function configureOptimizer(): undefined {
  binaryen.setOptimizeLevel(3);
  binaryen.setAlwaysInlineMaxSize(200000);
  return undefined;
}

/** Bind memory, table, and guest operand globals before constant folding. */
export function relocateFamily(module: binaryen.Module, memoryBase: number, tableBase: number,
  opcode: number, expansion: number): undefined {
  for (let index = module.getNumGlobals() - 1; index >= 0; --index) {
    const global = binaryen.getGlobalInfo(module.getGlobalByIndex(index));
    const base = global.base === "__memory_base" ? memoryBase :
      global.base === "__table_base" ? tableBase :
      global.module === "azahar.dsp" && global.base === "opcode" ? opcode :
      global.module === "azahar.dsp" && global.base === "expansion" ? expansion : undefined;
    if (base === undefined) continue;
    module.removeGlobal(global.name);
    module.addGlobal(global.name, binaryen.i32, false, module.i32.const(base));
  }
  return undefined;
}

/** Compile a generic native opcode body for subsequent guest-opcode specialization. */
export function compileFamily(templates: Uint8Array<ArrayBuffer>, target: string): Uint8Array<ArrayBuffer> {
  const module = binaryen.readBinary(templates);
  try {
    module.setFeatures(features);
    while (module.getNumExports()) {
      module.removeExport(binaryen.getExportInfo(module.getExportByIndex(0)).name);
    }
    while (module.getNumElementSegments()) {
      module.removeElementSegment(binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(0)).name);
    }
    // The core loads donor data once. Specialized entries only import the existing memory.
    module.runPasses(["remove-memory-init"]);
    // Inline the entry once; runtime specialization binds these immutable operands.
    module.addGlobalImport("azahar_dsp_opcode", "azahar.dsp", "opcode", binaryen.i32, false);
    module.addGlobalImport("azahar_dsp_expansion", "azahar.dsp", "expansion", binaryen.i32, false);
    module.addFunction("azahar_dsp_run", binaryen.i32, binaryen.none, [], module.call(target, [
      module.local.get(0, binaryen.i32), module.global.get("azahar_dsp_opcode", binaryen.i32),
      module.global.get("azahar_dsp_expansion", binaryen.i32),
    ], binaryen.none));
    module.addFunctionExport("azahar_dsp_run", "run");
    configureOptimizer();
    module.runPasses(["remove-unused-module-elements", "inlining-optimizing",
      "simplify-globals", "remove-unused-module-elements"]);
    for (let index = 0; index < module.getNumFunctions(); ++index) {
      const fn = binaryen.getFunctionInfo(module.getFunctionByIndex(index));
      if (fn.base?.includes("InstructionSemantics")) {
        throw new Error(`DSP opcode body imports native semantics: ${fn.base}`);
      }
    }
    return module.emitBinary() as Uint8Array<ArrayBuffer>;
  } finally { module.dispose(); }
}
