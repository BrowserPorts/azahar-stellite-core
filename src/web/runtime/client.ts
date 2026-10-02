// SPDX-License-Identifier: GPL-2.0-or-later

import type { SessionEvent, SessionRequest } from "./messages";
import type { InputState } from "./session";

export interface ClientOutput {
  video(frame: Extract<SessionEvent, { type: "video" }>): unknown;
  audio(samples: Int16Array<ArrayBuffer>): unknown;
  log(line: string): unknown;
  error(message: string): unknown;
}

interface Pending {
  resolve: (value: string | number | undefined) => unknown;
  reject: (error: Error) => unknown;
}

/** Owns one emulation worker, including its native pthread workers. */
export class AzaharClient {
  readonly ready: Promise<undefined>;
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #initialized = false;
  #disposed = false;
  #closing: Promise<undefined> | undefined;

  constructor(readonly output: ClientOutput,
    workerUrl = new URL("./azahar-worker.js", import.meta.url)) {
    this.#worker = new Worker(workerUrl, { type: "module", name: "Azahar" });
    this.ready = new Promise((resolve, reject) => {
      this.#worker.onmessage = (event: MessageEvent<SessionEvent>): undefined => {
        const value = event.data;
        switch (value.type) {
          case "ready": this.#initialized = true; resolve(undefined); break;
          case "reply": {
            const pending = this.#pending.get(value.id);
            this.#pending.delete(value.id);
            pending?.resolve(value.result);
            break;
          }
          case "error": {
            const error = new Error(value.message);
            if (!this.#initialized) { reject(error); this.dispose(error); }
            else if (value.id !== undefined) {
              const pending = this.#pending.get(value.id);
              this.#pending.delete(value.id);
              pending?.reject(error);
            } else output.error(value.message);
            break;
          }
          case "video": output.video(value); break;
          case "audio": output.audio(value.samples); break;
          case "log": output.log(value.line); break;
        }
        return undefined;
      };
      const failed = (message: string): undefined => {
        const error = new Error(message);
        reject(error);
        this.dispose(error);
        output.error(message);
        return undefined;
      };
      this.#worker.onerror = (event) => failed(event.message || "Azahar's worker stopped");
      this.#worker.onmessageerror = () => failed("Azahar's worker message could not be decoded");
    });
  }

  async load(file: File): Promise<string> {
    const result = await this.request({ type: "load", file });
    if (typeof result !== "string") throw new Error("Invalid game identity returned by Azahar");
    return result;
  }

  /** Attach a transferred canvas before starting emulation. */
  async connectSurface(canvas: OffscreenCanvas): Promise<undefined> {
    await this.request({ type: "surface", canvas }, [canvas]);
    return undefined;
  }

  async start(): Promise<undefined> { await this.request({ type: "start" }); return undefined; }
  async pause(): Promise<undefined> { await this.request({ type: "pause" }); return undefined; }
  async input(state: InputState): Promise<undefined> {
    await this.request({ type: "input", state }); return undefined;
  }

  async save(slot: number): Promise<number> {
    const result = await this.request({ type: "save", slot });
    if (typeof result !== "number") throw new Error("Invalid save-state size returned by Azahar");
    return result;
  }

  async restore(slot: number): Promise<number> {
    const result = await this.request({ type: "restore", slot });
    if (typeof result !== "number") throw new Error("Invalid save-state size returned by Azahar");
    return result;
  }

  close(): Promise<undefined> {
    if (this.#closing) return this.#closing;
    if (this.#disposed) return Promise.resolve(undefined);
    this.#closing = this.request({ type: "close" }).then(() => undefined)
      .finally(() => this.dispose(new Error("The Azahar session is closed")));
    return this.#closing;
  }

  private async request(request: SessionCommand,
    transfer: Transferable[] = []): Promise<string | number | undefined> {
    if (this.#closing) throw new Error("The Azahar session is closing");
    await this.ready;
    if (this.#disposed) throw new Error("The Azahar session is closed");
    if (this.#pending.size >= 64) throw new Error("The Azahar command queue is full");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#worker.postMessage({ ...request, id } satisfies SessionRequest, transfer); }
      catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  private dispose(error: Error): undefined {
    if (this.#disposed) return undefined;
    this.#disposed = true;
    this.#worker.terminate();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    return undefined;
  }
}

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type SessionCommand = WithoutId<SessionRequest>;
