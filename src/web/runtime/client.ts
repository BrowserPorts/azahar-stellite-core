// SPDX-License-Identifier: GPL-2.0-or-later

import type { SessionEvent, SessionRequest, SessionResult } from "./messages";
import { resolveRuntimeAssets } from "../assets";
import type { RuntimeAssets, RuntimeAssetOverrides } from "../assets";
export { runtimeAssetNames } from "../assets";
export type { RuntimeAssets, RuntimeAssetOverrides } from "../assets";
import type { CoreOption, InputState, InstalledTitle, MotionState, PerformanceStats } from "./session";
export type { CoreOption, InputState, InstalledTitle, MotionState } from "./session";
import { BrowserAudioOutput } from "./audio-output";
import { BrowserMicrophoneInput } from "./microphone-input";
export { BrowserMicrophoneInput } from "./microphone-input";
import { BrowserMotionInput } from "./motion-input";
import { BrowserInput } from "./browser-input";
import type { BrowserInputOptions } from "./browser-input";
export { BrowserAudioOutput } from "./audio-output";
export { BrowserMotionInput } from "./motion-input";
export { BrowserInput } from "./browser-input";
export type { BrowserInputOptions } from "./browser-input";
export type { AudioOutputStatistics } from "./audio-output";

export interface ClientOutput {
  video(frame: Extract<SessionEvent, { type: "video" }>): unknown;
  /** Interleaved stereo PCM at Azahar's native sample rate. */
  audio(samples: Int16Array<ArrayBuffer>, sampleRate: number): unknown;
  log(line: string): unknown;
  error(message: string): unknown;
  installProgress?(written: number, total: number): unknown;
}

interface Pending {
  resolve: (value: SessionResult) => unknown;
  reject: (error: Error) => unknown;
}

export interface ClientOptions {
  assets?: RuntimeAssetOverrides;
}

/** Owns one emulation worker, including its native pthread workers. */
export class AzaharClient {
  readonly ready: Promise<undefined>;
  readonly #worker: Worker;
  readonly #assets: RuntimeAssets;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #initialized = false;
  #disposed = false;
  #closing: Promise<undefined> | undefined;
  #audio: BrowserAudioOutput | undefined;
  #audioClosing: Promise<undefined> | undefined;
  #connectingAudio: AbortController | undefined;
  #audioConnection: Promise<BrowserAudioOutput> | undefined;
  #motion: BrowserMotionInput | undefined;
  #motionController: AbortController | undefined;
  #motionConnection: Promise<BrowserMotionInput> | undefined;
  #input: BrowserInput | undefined;
  #inputController: AbortController | undefined;
  #microphone: BrowserMicrophoneInput | undefined;
  #microphoneController: AbortController | undefined;
  #microphoneConnection: Promise<BrowserMicrophoneInput> | undefined;
  #microphoneClosing: Promise<undefined> | undefined;
  #sampleRate = 0;
  #rejectReady: ((error: Error) => unknown) | undefined;

  constructor(readonly output: ClientOutput, options: URL | ClientOptions = {}) {
    this.#assets = options instanceof URL ?
      resolveRuntimeAssets(options.href, { "azahar-worker.js": options.href }) :
      resolveRuntimeAssets(import.meta.url, options.assets);
    this.#worker = new Worker(this.#assets["azahar-worker.js"], { type: "module", name: "Azahar" });
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
          case "install-progress": output.installProgress?.(value.written, value.total); break;
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
      try { this.#worker.postMessage({ type: "initialize", assets: this.#assets }); }
      catch (error) { failed(error instanceof Error ? error.message : String(error)); }
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

  /** Install a CIA package into persistent emulated storage before loading a game. */
  async install(file: File): Promise<undefined> {
    await this.request({ type: "install", file });
    return undefined;
  }

  async installedTitles(): Promise<InstalledTitle[]> {
    const result = await this.request({ type: "installed-titles" });
    if (!Array.isArray(result)) throw new Error("Invalid installed title list returned by Azahar");
    return result as InstalledTitle[];
  }

  async loadInstalled(title: string): Promise<string> {
    const result = await this.request({ type: "load-installed", title });
    if (typeof result !== "string") throw new Error("Invalid installed game identity returned by Azahar");
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
          message => this.output.error(message), controller.signal, this.#assets["azahar-audio-worklet.js"]);
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

  /** Request microphone access from a user gesture after ready. Uses Auto/Frontend input. */
  async connectMicrophone(): Promise<BrowserMicrophoneInput> {
    if (!this.#initialized || this.#disposed || this.#closing) throw new Error("Azahar is not ready for microphone input");
    if (this.#microphoneConnection || (this.#microphone && !this.#microphone.closed)) {
      throw new Error("Browser microphone is already connected");
    }
    const controller = new AbortController();
    this.#microphoneController = controller;
    const connection = (async () => {
      let microphone: BrowserMicrophoneInput | undefined;
      try {
        microphone = await BrowserMicrophoneInput.create(message => this.output.error(message), controller.signal,
          this.#assets["azahar-microphone-worklet.js"]);
        await this.request({ type: "microphone-input", transport: microphone.transport });
        if (microphone.closed) throw new Error("The microphone closed while connecting");
        if (this.#closing || this.#disposed) throw new Error("The Azahar session is closing");
        this.#microphone = microphone;
        return microphone;
      } catch (error) {
        await microphone?.close();
        throw error;
      } finally { this.#microphoneConnection = undefined; }
    })();
    this.#microphoneConnection = connection;
    return connection;
  }

  async start(): Promise<undefined> {
    await this.#audio?.resume();
    await this.request({ type: "start" });
    return undefined;
  }

  /** Capture device sensors; call from a user gesture after ready. */
  async connectMotion(): Promise<BrowserMotionInput> {
    if (!this.#initialized || this.#disposed || this.#closing) throw new Error("Azahar is not ready for motion");
    if (this.#motionConnection || (this.#motion && !this.#motion.closed)) {
      throw new Error("Browser motion is already connected");
    }
    const controller = new AbortController();
    this.#motionController = controller;
    const connection = (async () => {
      try {
        const motion = await BrowserMotionInput.create(state => this.motion(state),
          message => this.output.error(message), controller.signal);
        if (this.#closing || this.#disposed) {
          controller.abort();
          throw new Error("The Azahar session is closing");
        }
        this.#motion = motion;
        return motion;
      } finally { this.#motionConnection = undefined; }
    })();
    this.#motionConnection = connection;
    return connection;
  }

  /** Attach keyboard, touchscreen and standard gamepad controls to the displayed canvas. */
  connectInput(canvas: HTMLCanvasElement, options: BrowserInputOptions = {}): BrowserInput {
    if (!this.#initialized || this.#disposed || this.#closing) throw new Error("Azahar is not ready for input");
    if (this.#input && !this.#input.closed) throw new Error("Browser input is already connected");
    const controller = new AbortController();
    const input = BrowserInput.create(canvas, state => this.sendInput(state),
      message => this.output.error(message), controller.signal, options);
    this.#inputController = controller;
    this.#input = input;
    return input;
  }

  async pause(): Promise<undefined> {
    await this.request({ type: "pause" });
    await this.#audio?.suspend();
    return undefined;
  }

  /** Restart the loaded game, preserving whether emulation is running or paused. */
  async reset(): Promise<undefined> {
    await this.request({ type: "reset" });
    return undefined;
  }
  /** Advance and finish rendering one native frame while paused. */
  async advanceFrame(): Promise<undefined> {
    await this.request({ type: "advance-frame" });
    return undefined;
  }
  /** Merge host controls with any connected canvas controls. */
  async input(state: InputState): Promise<undefined> {
    if (this.#input && !this.#input.closed) return this.#input.setHostInput(state);
    return this.sendInput(state);
  }

  private async sendInput(state: InputState): Promise<undefined> {
    await this.request({ type: "input", state }); return undefined;
  }

  /** Supply device-coordinate motion directly, or null to reset to a stationary device. */
  async motion(state: MotionState | null): Promise<undefined> {
    await this.request({ type: "motion", state }); return undefined;
  }

  /** Native option descriptions include any game restart requirements. */
  async options(): Promise<CoreOption[]> {
    const result = await this.request({ type: "options" });
    if (!Array.isArray(result)) throw new Error("Invalid core options returned by Azahar");
    return result as CoreOption[];
  }

  /** Applies at game load or the next frame; restart-only settings require a reset. */
  async setOption(key: string, value: string): Promise<undefined> {
    await this.request({ type: "set-option", key, value });
    return undefined;
  }

  /** Read and reset performance counters at an emulation frame boundary. */
  async performance(): Promise<PerformanceStats> {
    const result = await this.request({ type: "performance" });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid performance snapshot returned by Azahar");
    }
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
    this.#motionController?.abort();
    this.#microphoneController?.abort();
    this.#inputController?.abort();
    if (this.#disposed) return Promise.all([
      this.#audioClosing, this.#audioConnection?.catch(() => undefined),
      this.#motionConnection?.catch(() => undefined),
      this.#microphoneConnection?.catch(() => undefined), this.#microphone?.close(),
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
        await this.#motionConnection?.catch(() => undefined);
        await this.#microphoneConnection?.catch(() => undefined);
        await this.#microphoneClosing;
        await this.#audioClosing;
      });
    return this.#closing;
  }

  private async request(request: SessionCommand,
    transfer: Transferable[] = []): Promise<SessionResult> {
    if (this.#closing) throw new Error("The Azahar session is closing");
    await this.ready;
    if (this.#disposed) throw new Error("The Azahar session is closed");
    // Closing must drain accepted commands and run native shutdown even at capacity.
    if (this.#pending.size >= 64 && request.type !== "close") {
      throw new Error("The Azahar command queue is full");
    }
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
    this.#motionController?.abort();
    this.#microphoneController?.abort();
    this.#inputController?.abort();
    this.#microphoneClosing = this.#microphone?.close();
    this.#microphoneClosing?.catch(error => this.output.error(String(error)));
    this.#audioClosing = this.#audio?.close();
    this.#audioClosing?.catch(error => this.output.error(String(error)));
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    return undefined;
  }
}

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
type SessionCommand = WithoutId<SessionRequest>;
