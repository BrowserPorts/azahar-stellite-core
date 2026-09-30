// SPDX-License-Identifier: GPL-2.0-or-later

import { pathToFileURL } from "node:url";
import { ArmJitHost } from "../../arm/jit-host";
import { PicaJitHost } from "../../pica/jit-host";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An upstream fixture module path is required");
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const args = process.argv.slice(3);
const dispatch = args.includes("--pica-dispatch");
await createModule({ arguments: args.filter((arg) => arg !== "--pica-dispatch"),
  azaharJitHost: new ArmJitHost(), azaharPicaJitHost: new PicaJitHost(dispatch) });
