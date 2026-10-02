// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";

const [path, ...args] = process.argv.slice(2);
if (!path) throw new Error("A native Wasm fixture executable is required");
const root = process.cwd();
const wasi = new WASI({
  version: "preview1",
  args: [path, ...args],
  env: process.env,
  preopens: { [root]: root },
  returnOnExit: true,
});
const { instance } = await WebAssembly.instantiate(await readFile(path), wasi.getImportObject());
process.exitCode = wasi.start(instance);
