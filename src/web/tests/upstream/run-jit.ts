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
process.on("exit", () => {
  const count = linkedBlocks?.();
  if (count) console.log(`ARM JIT: ${count} blocks entered through direct Wasm links`);
});
await createModule({ arguments: args.filter((arg) => arg !== "--pica-dispatch"),
  azaharJitHost: new ArmJitHost(), azaharPicaJitHost: new PicaJitHost(dispatch),
  preRun: [(module: { FS: { writeFile(path: string, data: Uint8Array): undefined },
    ENV: Record<string, string>; _azahar_arm_jit_linked_blocks?: () => bigint }) => {
    linkedBlocks = module._azahar_arm_jit_linked_blocks;
    if (replay) {
      module.FS.writeFile("/thumb-it.case", replay);
      module.ENV.DYNARMIC_THUMB_IT_REPLAY = "/thumb-it.case";
    }
  }] });
