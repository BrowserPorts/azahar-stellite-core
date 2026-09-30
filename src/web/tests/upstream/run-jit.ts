// SPDX-License-Identifier: GPL-2.0-or-later

import { pathToFileURL } from "node:url";
import { ArmJitHost } from "../../arm/jit-host";
import { PicaJitHost } from "../../pica/jit-host";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("An upstream fixture module path is required");
const { default: createModule } = await import(pathToFileURL(modulePath).href);
await createModule({ arguments: process.argv.slice(3), azaharJitHost: new ArmJitHost(),
  azaharPicaJitHost: new PicaJitHost() });
