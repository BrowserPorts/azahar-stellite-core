// SPDX-License-Identifier: GPL-2.0-or-later

import type { Worker as NodeWorker } from "node:worker_threads";
import { OptimizerMailbox, type OptimizerSignal } from "./optimizer-mailbox";
import type { OptimizerRequest } from "./optimizer-worker";

export interface OptimizerAssets { workerUrl: string; compilerUrl: string; }
type WorkerFactory = () => Worker | NodeWorker;

/** Prepare the platform factory; the first DSP execution starts its compiler. */
export async function prepareDspOptimizer(assets: OptimizerAssets): Promise<
  (memory: SharedArrayBuffer, signal: OptimizerSignal) => Promise<DspOptimizer>> {
  let createWorker: WorkerFactory;
  if (typeof process === "object" && process.versions?.node) {
    const { Worker: NativeWorker } = await import("node:worker_threads");
    createWorker = () => new NativeWorker(new URL(assets.workerUrl));
  } else createWorker = () => new Worker(assets.workerUrl, { type: "module" });
  return async (memory, signal) => {
    const optimizer = new DspOptimizer(createWorker(), signal);
    try {
      await optimizer.ready;
      await optimizer.initialize(memory, assets.compilerUrl);
      return optimizer;
    } catch (error) {
      optimizer.close();
      throw error;
    }
  };
}

export class DspOptimizer {
  readonly mailbox: OptimizerMailbox;
  readonly ready: Promise<undefined>;
  #failure: unknown;
  #initializing: { resolve: (value: undefined) => unknown; reject: (error: unknown) => unknown } | undefined;

  constructor(readonly worker: Worker | NodeWorker, signal: OptimizerSignal) {
    this.mailbox = new OptimizerMailbox(undefined, signal);
    let resolveReady: (value: undefined) => unknown;
    let rejectReady: (error: unknown) => unknown;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const ready = (message: unknown) => {
      if (message === "ready") resolveReady(undefined);
      else if (message === "initialized") {
        this.#initializing?.resolve(undefined);
        this.#initializing = undefined;
      }
      else if (message && typeof message === "object" && "error" in message && typeof message.error === "string") {
        failed(new Error(message.error));
      }
    };
    const failed = (error: unknown) => {
      if (!this.mailbox.closed) { this.#failure = error; this.mailbox.fail(); }
      rejectReady(error);
      this.#initializing?.reject(error);
      this.#initializing = undefined;
    };
    if ("addEventListener" in worker) {
      worker.addEventListener("error", event => failed(new Error(event.message)));
      worker.addEventListener("messageerror", () => failed(new Error("DSP optimizer message could not be decoded")));
      worker.addEventListener("message", event => ready(event.data));
    } else {
      worker.on("error", failed);
      worker.on("exit", code => failed(new Error(`DSP optimizer exited with status ${code}`)));
      worker.on("message", ready);
    }
  }

  initialize(memory: SharedArrayBuffer, compilerUrl: string): Promise<undefined> {
    return new Promise((resolve, reject) => {
      this.#initializing = { resolve, reject };
      this.worker.postMessage({ kind: "initialize", buffers: this.mailbox.buffers,
        memory, compilerUrl } satisfies OptimizerRequest);
    });
  }

  request(key: number, bytes: Uint8Array<ArrayBuffer>, ranges: [number, number][]): undefined {
    this.worker.postMessage({ kind: "compile", key, bytes, ranges } satisfies OptimizerRequest, [bytes.buffer]);
    return undefined;
  }

  check(): undefined {
    if (this.mailbox.closed) throw new Error("DSP optimizer is closed");
    if (this.mailbox.failed) throw this.#failure ?? new Error("DSP optimization failed");
    return undefined;
  }

  close(): undefined {
    this.mailbox.close();
    Promise.resolve(this.worker.terminate()).catch(() => undefined);
    return undefined;
  }
}
