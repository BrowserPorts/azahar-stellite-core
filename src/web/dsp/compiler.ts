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

/** Bind the side module's relocation globals to this core's memory and table. */
export function relocateFamily(module: binaryen.Module, memoryBase: number, tableBase: number): undefined {
  for (let index = module.getNumGlobals() - 1; index >= 0; --index) {
    const global = binaryen.getGlobalInfo(module.getGlobalByIndex(index));
    const base = global.base === "__memory_base" ? memoryBase :
      global.base === "__table_base" ? tableBase : undefined;
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
    module.addFunctionExport(target, "template");
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
