// SPDX-License-Identifier: GPL-2.0-or-later

import type { SessionEvent, SessionRequest, SessionResult } from "./messages";
import type { InputState, PerformanceStats } from "./session";
import { BrowserAudioOutput } from "./audio-output";
export { BrowserAudioOutput } from "./audio-output";
export type { AudioOutputStatistics } from "./audio-output";

export interface ClientOutput {
  video(frame: Extract<SessionEvent, { type: "video" }>): unknown;
  /** Interleaved stereo PCM at Azahar's native sample rate. */
  audio(samples: Int16Array<ArrayBuffer>, sampleRate: number): unknown;
  log(line: string): unknown;
  error(message: string): unknown;
}

interface Pending {
  resolve: (value: SessionResult) => unknown;
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
  #audio: BrowserAudioOutput | undefined;
  #audioClosing: Promise<undefined> | undefined;
  #connectingAudio: AbortController | undefined;
  #audioConnection: Promise<BrowserAudioOutput> | undefined;
  #sampleRate = 0;
  #rejectReady: ((error: Error) => unknown) | undefined;

  constructor(readonly output: ClientOutput,
    workerUrl = new URL("./azahar-worker.js", import.meta.url)) {
    this.#worker = new Worker(workerUrl, { type: "module", name: "Azahar" });
    this.ready = new Promise((resolve, reject) => {
      this.#rejectReady = reject;
      this.#worker.onmessage = (event: MessageEvent<SessionEvent>): undefined => {
        const value = event.data;
        switch (value.type) {
          case "ready":
            this.#sampleRate = value.sampleRate;
            this.#initialized = true;
            this.#rejectReady = undefined;
            resolve(undefined);
            break;
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
          case "audio": output.audio(value.samples, value.sampleRate); break;
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

  /** Copy a file to a relative user path, such as sdmc/3ds/dspfirm.cdc, before loading a game. */
  async importUserFile(file: File, path: string): Promise<number> {
    const result = await this.request({ type: "import-user-file", file, path });
    if (typeof result !== "number") throw new Error("Invalid imported file size returned by Azahar");
    return result;
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

  /** Play native PCM on an audio worklet; call from a user gesture after ready.
   * Connected playback replaces PCM messages to the audio callback. */
  async connectAudio(): Promise<BrowserAudioOutput> {
    if (!this.#initialized || this.#disposed || this.#closing) throw new Error("Azahar is not ready for audio");
    if (this.#audio || this.#connectingAudio) throw new Error("Browser audio is already connected");
    const controller = new AbortController();
    this.#connectingAudio = controller;
    const connection = (async () => {
      let audio: BrowserAudioOutput | undefined;
      try {
        audio = await BrowserAudioOutput.create(this.#sampleRate,
          message => this.output.error(message), controller.signal);
        await this.request({ type: "audio-output", transport: audio.transport });
        if (this.#closing || this.#disposed) throw new Error("The Azahar session is closing");
        this.#audio = audio;
        return audio;
      } catch (error) {
        await audio?.close();
        throw error;
      } finally { this.#connectingAudio = undefined; this.#audioConnection = undefined; }
    })();
    this.#audioConnection = connection;
    return connection;
  }

  async start(): Promise<undefined> {
    await this.#audio?.resume();
    await this.request({ type: "start" });
    return undefined;
  }
  async pause(): Promise<undefined> {
    await this.request({ type: "pause" });
    await this.#audio?.suspend();
    return undefined;
  }
  /** Advance one native frame while paused. */
  async advanceFrame(): Promise<undefined> {
    await this.request({ type: "advance-frame" });
    return undefined;
  }
  async input(state: InputState): Promise<undefined> {
    await this.request({ type: "input", state }); return undefined;
  }

  /** Read and reset performance counters at an emulation frame boundary. */
  async performance(): Promise<PerformanceStats> {
    const result = await this.request({ type: "performance" });
    if (!result || typeof result !== "object") throw new Error("Invalid performance snapshot returned by Azahar");
    return result;
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
    if (this.#disposed) return Promise.all([
      this.#audioClosing, this.#audioConnection?.catch(() => undefined),
    ]).then(() => undefined);
    if (!this.#initialized) {
      this.#closing = Promise.resolve(undefined);
      this.ready.catch(() => undefined);
      this.dispose(new Error("The Azahar session is closed"));
      return this.#closing;
    }
    this.#closing = this.request({ type: "close" }).then(() => undefined)
      .finally(async () => {
        this.dispose(new Error("The Azahar session is closed"));
        await this.#audioConnection?.catch(() => undefined);
        await this.#audioClosing;
      });
    return this.#closing;
  }

  private async request(request: SessionCommand,
    transfer: Transferable[] = []): Promise<SessionResult> {
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
    this.#rejectReady?.(error);
    this.#rejectReady = undefined;
    this.#worker.terminate();
    this.#connectingAudio?.abort();
    this.#audioClosing = this.#audio?.close();
    this.#audioClosing?.catch(error => this.output.error(String(error)));
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    return undefined;
  }
}

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type SessionCommand = WithoutId<SessionRequest>;
