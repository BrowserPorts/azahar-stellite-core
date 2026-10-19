// SPDX-License-Identifier: GPL-2.0-or-later

import { OptimizerMailbox, type OptimizerBuffers } from "./optimizer-mailbox";
import type { optimizeDsp } from "./optimizer";

export type OptimizerRequest = {
  kind: "initialize"; buffers: OptimizerBuffers; memory: SharedArrayBuffer; compilerUrl: string;
} | {
  kind: "compile"; key: number; bytes: Uint8Array<ArrayBuffer>; ranges: [number, number][];
};

let mailbox: OptimizerMailbox | undefined;
let memory: Uint8Array<SharedArrayBuffer> | undefined;
let optimize: typeof optimizeDsp | undefined;
let initialized: () => unknown;
let failed: (error: string) => unknown;
let work = Promise.resolve();

function receive(request: OptimizerRequest): undefined {
  work = work.then(async () => {
    if (request.kind === "initialize") {
      mailbox = new OptimizerMailbox(request.buffers);
      memory = new Uint8Array(request.memory);
      optimize = (await import(request.compilerUrl)).optimizeDsp;
      if (typeof optimize !== "function") throw new Error("DSP optimizer entry is unavailable");
      initialized();
      return;
    }
    if (mailbox?.closed || mailbox?.failed) return;
    if (!mailbox || !memory || !optimize) throw new Error("DSP optimizer is not initialized");
    const started = performance.now();
    const result = optimize(request.bytes, memory, request.ranges);
    mailbox.write({ key: request.key, ...result, elapsedMs: performance.now() - started, error: false });
  }).catch(error => {
    if (mailbox?.closed || mailbox?.failed) return;
    failed(String(error));
    if (!mailbox) return;
    try {
      mailbox.write({ key: request.kind === "compile" ? request.key : 0,
        bytes: new TextEncoder().encode(String(error)), elapsedMs: 0, foldedLoads: 0, error: true });
    } finally { mailbox.fail(); }
  });
  return undefined;
}

if (typeof self === "object") {
  initialized = () => self.postMessage("initialized");
  failed = error => self.postMessage({ error });
  self.onmessage = (event: MessageEvent<OptimizerRequest>) => receive(event.data);
  self.postMessage("ready");
} else {
  const { parentPort } = await import("node:worker_threads");
  if (!parentPort) throw new Error("DSP optimizer must run in a worker");
  initialized = () => parentPort.postMessage("initialized");
  failed = error => parentPort.postMessage({ error });
  parentPort.on("message", receive);
  parentPort.postMessage("ready");
}
