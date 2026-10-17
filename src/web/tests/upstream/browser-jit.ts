// SPDX-License-Identifier: GPL-2.0-or-later

import type { FixtureReply, FixtureRequest } from "./browser-worker";

const output = document.querySelector("pre");
if (!output) throw new Error("Fixture output element is missing");
const append = (line: string): undefined => {
  output.textContent += `${line}\n`;
  return undefined;
};
const recordings = new URL(location.href).searchParams.has("recordings");
const core = new URL(location.href).searchParams.has("core");
const dispatch = new URL(location.href).searchParams.has("pica-dispatch");
const fuzz = new URL(location.href).searchParams.has("fuzz");
const dsp = new URL(location.href).searchParams.has("dsp");
const lazyDsp = new URL(location.href).searchParams.has("lazy-dsp");
const regionTier = new URL(location.href).searchParams.has("region-tier");
const filter = new URL(location.href).searchParams.get("filter");
const seed = new URL(location.href).searchParams.get("seed");
const sections = new URL(location.href).searchParams.getAll("section");
const storage = new URL(location.href).searchParams.get("storage");
const firmwareDirectory = new URL(location.href).searchParams.get("firmware");
const firmware = firmwareDirectory ? await Promise.all(["dspfirm.cdc", "dspaudio.cdc"].map(async name => {
  const response = await fetch(new URL(name, new URL(firmwareDirectory, location.href)));
  if (!response.ok) throw new Error(`Could not load DSP firmware ${name}`);
  return { name, data: new Uint8Array(await response.arrayBuffer()) };
})) : [];
if (storage !== null && storage !== "setup" && storage !== "resume" && storage !== "errors") {
  throw new Error("Invalid OPFS fixture mode");
}
const fixtureUrl = new URL(dsp && !core ? "./teakra_reference_fixtures.mjs" : storage ? `./wasmfs_opfs_${storage}.mjs` : core ? "./tests.mjs" : fuzz ? "./dynarmic_arm_fuzz_fixtures.mjs" : recordings ? "./dynarmic_vfp_recordings.mjs" :
  "./dynarmic_arm_jit_fixtures.mjs", import.meta.url);
const worker = new Worker(new URL("./browser-worker.js", import.meta.url), { type: "module" });
worker.onmessage = (event: MessageEvent<FixtureReply>): undefined => {
  if ("line" in event.data) append(event.data.line);
  else {
    document.body.dataset.exitCode = String(event.data.exit);
    worker.terminate();
  }
  return undefined;
};
worker.onerror = (event: ErrorEvent): undefined => {
  append(event.message);
  document.body.dataset.exitCode = "1";
  worker.terminate();
  return undefined;
};
worker.postMessage({ url: fixtureUrl.href,
  args: recordings || storage ? [] : ["--reporter", "compact", ...(filter ? [filter] : []),
    ...(seed ? ["--rng-seed", seed] : []), ...sections.flatMap(section => ["--section", section])],
  dispatch, dsp, lazyDsp, regionTier, firmware } satisfies FixtureRequest);
