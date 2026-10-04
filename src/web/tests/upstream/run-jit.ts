// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ArmJitHost } from "../../arm/jit-host";
import { PicaJitHost } from "../../pica/jit-host";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An upstream fixture module path is required");
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const args = process.argv.slice(3);
const dispatch = args.includes("--pica-dispatch");
const replayPath = process.env.DYNARMIC_THUMB_IT_REPLAY;
const replay = replayPath ? await readFile(replayPath) : undefined;
let linkedBlocks: (() => bigint) | undefined;
let budgetReuses: (() => bigint) | undefined;
let fastDispatchHits: (() => bigint) | undefined;
const armJit = new ArmJitHost();
process.on("exit", () => {
  const count = linkedBlocks?.();
  if (count) console.log(`ARM JIT: ${count} blocks entered through direct Wasm links`);
  const reuses = budgetReuses?.();
  if (reuses) console.log(`ARM JIT: ${reuses} cached regions reused with a smaller tick budget`);
  const fast = fastDispatchHits?.();
  if (fast) console.log(`ARM JIT: ${fast} native and emitted Wasm dispatch-cache hits`);
  const stats = armJit.takeStatistics();
  if (stats.optimizedRegions) console.log(`ARM JIT: ${stats.optimizedRegions} hot regions compiled with direct Wasm calls`);
  if (stats.compiledBlocks) console.log(`ARM JIT: ${stats.compiledBlocks} regions, ${stats.generatedBytes} Wasm bytes, ${stats.compileMs.toFixed(2)} ms compilation`);
});
await createModule({ arguments: args.filter((arg) => arg !== "--pica-dispatch"),
  azaharJitHost: armJit, azaharPicaJitHost: new PicaJitHost(dispatch),
  preRun: [(module: { FS: { writeFile(path: string, data: Uint8Array): undefined },
    ENV: Record<string, string>; _azahar_arm_jit_linked_blocks?: () => bigint;
    _azahar_arm_jit_budget_reuses?: () => bigint;
    _azahar_arm_jit_fast_dispatch_hits?: () => bigint }) => {
    linkedBlocks = module._azahar_arm_jit_linked_blocks;
    budgetReuses = module._azahar_arm_jit_budget_reuses;
    fastDispatchHits = module._azahar_arm_jit_fast_dispatch_hits;
    if (replay) {
      module.FS.writeFile("/thumb-it.case", replay);
      module.ENV.DYNARMIC_THUMB_IT_REPLAY = "/thumb-it.case";
    }
  }] });
