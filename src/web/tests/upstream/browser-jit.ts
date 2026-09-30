// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../../arm/jit-host";

const output = document.querySelector("pre");
if (!output) throw new Error("Fixture output element is missing");
const append = (line: string): undefined => {
  output.textContent += `${line}\n`;
  return undefined;
};
const recordings = new URL(location.href).searchParams.has("recordings");
const core = new URL(location.href).searchParams.has("core");
const fixtureUrl = new URL(core ? "./tests.mjs" : recordings ? "./dynarmic_vfp_recordings.mjs" :
  "./dynarmic_arm_jit_fixtures.mjs", import.meta.url);
try {
  const { default: createModule } = await import(fixtureUrl.href);
  await createModule({
    azaharJitHost: new ArmJitHost(),
    arguments: recordings ? [] : ["--reporter", "compact"],
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
