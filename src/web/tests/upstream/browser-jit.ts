// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../../arm/jit-host";
import { PicaJitHost } from "../../pica/jit-host";

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
const filter = new URL(location.href).searchParams.get("filter");
const fixtureUrl = new URL(core ? "./tests.mjs" : fuzz ? "./dynarmic_arm_fuzz_fixtures.mjs" : recordings ? "./dynarmic_vfp_recordings.mjs" :
  "./dynarmic_arm_jit_fixtures.mjs", import.meta.url);
try {
  const { default: createModule } = await import(fixtureUrl.href);
  await createModule({
    azaharJitHost: new ArmJitHost(),
    azaharPicaJitHost: new PicaJitHost(dispatch),
    arguments: recordings ? [] : ["--reporter", "compact", ...(filter ? [filter] : [])],
    print: append,
    printErr: append,
    onExit: (status: number): undefined => {
      document.body.dataset.exitCode = String(status);
      return undefined;
    },
  });
} catch (error) {
  append(String(error));
  document.body.dataset.exitCode = "1";
}
