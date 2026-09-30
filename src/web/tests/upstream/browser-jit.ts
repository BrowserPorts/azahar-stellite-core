// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../../arm/jit-host";

const output = document.querySelector("pre");
if (!output) throw new Error("Fixture output element is missing");
const append = (line: string): undefined => {
  output.textContent += `${line}\n`;
  return undefined;
};
const fixtureUrl = new URL("./dynarmic_arm_jit_fixtures.mjs", import.meta.url);
try {
  const { default: createModule } = await import(fixtureUrl.href);
  await createModule({
    azaharJitHost: new ArmJitHost(),
    arguments: ["--reporter", "compact"],
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
