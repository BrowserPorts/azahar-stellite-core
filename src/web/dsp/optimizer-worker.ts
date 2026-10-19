// SPDX-License-Identifier: GPL-2.0-or-later

import { OptimizerMailbox, type OptimizerBuffers } from "./optimizer-mailbox";
import { DspOptimizerCache } from "./optimizer-cache";
import type { optimizeDsp } from "./optimizer";

export type OptimizerRequest = {
  kind: "initialize"; buffers: OptimizerBuffers; memory: SharedArrayBuffer; compilerUrl: string;
} | {
  kind: "compile"; key: number; bytes: Uint8Array<ArrayBuffer>; ranges: [number, number][];
};

let mailbox: OptimizerMailbox | undefined;
let memory: Uint8Array<SharedArrayBuffer> | undefined;
let optimize: typeof optimizeDsp | undefined;
let compilerUrl: string | undefined;
let cache: DspOptimizerCache | undefined;
let initialized: () => unknown;
let failed: (error: string) => unknown;
let work = Promise.resolve();

async function compiler(): Promise<typeof optimizeDsp> {
  if (!optimize) {
    if (!compilerUrl) throw new Error("DSP optimizer is not initialized");
    optimize = (await import(compilerUrl)).optimizeDsp;
    if (typeof optimize !== "function") throw new Error("DSP optimizer entry is unavailable");
  }
  return optimize;
}

function receive(request: OptimizerRequest): undefined {
  const lookupCache = cache;
  const lookupMemory = memory;
  const pendingLookup = request.kind === "compile" && lookupCache && lookupMemory &&
    !mailbox?.closed && !mailbox?.failed ?
    lookupCache.lookup(request.bytes, lookupMemory, request.ranges) : undefined;
  work = work.then(async () => {
    if (request.kind === "initialize") {
      mailbox = new OptimizerMailbox(request.buffers);
      memory = new Uint8Array(request.memory);
      compilerUrl = request.compilerUrl;
      cache = await DspOptimizerCache.open(compilerUrl);
      if (!cache) await compiler();
      initialized();
      return;
    }
    if (mailbox?.closed || mailbox?.failed) return;
    if (!mailbox || !memory || !compilerUrl) throw new Error("DSP optimizer is not initialized");
    const lookup = pendingLookup && lookupCache === cache && lookupMemory === memory ?
      await pendingLookup : await cache?.lookup(request.bytes, memory, request.ranges);
    const started = performance.now();
    const key = lookup?.key;
    let result = lookup?.entry;
    if (!result) {
      result = (await compiler())(request.bytes, memory, request.ranges);
      if (key) cache!.store(key, result);
    }
    mailbox.write({ key: request.key, ...result,
      elapsedMs: (lookup?.elapsedMs ?? 0) + performance.now() - started, error: false });
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
