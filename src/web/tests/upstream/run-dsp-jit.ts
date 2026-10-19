// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DspJitHost } from "../../dsp/jit-host";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An upstream Teakra fixture module path is required");
const [templates, families] = await Promise.all([
  readFile(join(dirname(modulePath), "azahar-dsp-templates.wasm")),
  readFile(join(dirname(modulePath), "azahar-dsp-families.bin")),
]);
const host = await DspJitHost.create(Uint8Array.from(templates), Uint8Array.from(families), {
  workerUrl: pathToFileURL(join(dirname(modulePath), "azahar-dsp-optimizer-worker.mjs")).href,
  compilerUrl: pathToFileURL(join(dirname(modulePath), "azahar-dsp-optimizer.mjs")).href,
}, (count) => {
  if (count % 1000 === 0) console.log(`DSP JIT: ${count} specializations compiled`);
});
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const module = await createModule({ noInitialRun: true, azaharDspJitHost: host });
process.on("exit", () => {
  host.stopOptimization();
  console.log(`DSP JIT: ${module._azahar_dsp_jit_entries()} entries installed across Wasm threads`);
  console.log(`DSP JIT: ${module._azahar_dsp_jit_optimized_entries()} entries optimized across Wasm threads`);
  if (host.compilations) {
    console.log(`DSP JIT: ${host.compilations} specializations, ${host.emittedBytes} bytes, ${host.foldedLoads} immutable loads folded`);
    console.log(`DSP JIT: ${host.coldBytes} cold bytes, ${host.optimizedBytes} optimized bytes`);
  }
});
try { await module.callMain(process.argv.slice(3)); }
catch (error) {
  host.stopOptimization();
  if (error !== null && typeof error === "object" && "getArg" in error) {
    console.error(module.getExceptionMessage(error));
  }
  throw error;
}
