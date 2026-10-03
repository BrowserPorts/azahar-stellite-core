// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DspJitHost } from "../../dsp/jit-host";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An upstream Teakra fixture module path is required");
const data = await readFile(join(dirname(modulePath), "azahar-dsp-templates.wasm"));
const host = new DspJitHost(Uint8Array.from(data), (count) => {
  if (count % 1000 === 0) console.log(`DSP JIT: ${count} specializations compiled`);
});
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const module = await createModule({ noInitialRun: true, azaharDspJitHost: host });
process.on("exit", () => {
  console.log(`DSP JIT: ${module._azahar_dsp_jit_entries()} entries installed across Wasm threads`);
  if (host.compilations) console.log(`DSP JIT: ${host.compilations} specializations, ${host.emittedBytes} bytes`);
});
try { module.callMain(process.argv.slice(3)); }
catch (error) {
  if (error !== null && typeof error === "object" && "getArg" in error) {
    console.error(module.getExceptionMessage(error));
  }
  throw error;
}
