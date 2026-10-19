// SPDX-License-Identifier: GPL-2.0-or-later

import binaryen from "binaryen";
import { configureOptimizer, features } from "./compiler";
import { foldReadOnlyLoads } from "./fold-readonly-loads.js";

configureOptimizer();

/** Fold bound operands and immutable native lookup tables into a hot Wasm entry. */
export function optimizeDsp(bytes: Uint8Array<ArrayBuffer>, memory: Uint8Array,
  ranges: readonly [number, number][]): { bytes: Uint8Array<ArrayBuffer>; foldedLoads: number } {
  const module = binaryen.readBinary(bytes);
  let foldedLoads = 0;
  try {
    module.setFeatures(features);
    module.runPasses(["simplify-globals", "precompute-propagate", "dce", "vacuum",
      "remove-unused-module-elements"]);
    if (ranges.length) {
      let folded;
      do {
        folded = foldReadOnlyLoads(module, memory, ranges);
        foldedLoads += folded;
        if (folded) module.runPasses(["precompute-propagate", "dce", "vacuum"]);
      } while (folded);
    }
    module.runPasses(["simplify-locals-nostructure", "precompute-propagate", "merge-blocks",
      "remove-unused-brs", "vacuum", "coalesce-locals", "remove-unused-module-elements"]);
    return { bytes: module.emitBinary() as Uint8Array<ArrayBuffer>, foldedLoads };
  } finally { module.dispose(); }
}
