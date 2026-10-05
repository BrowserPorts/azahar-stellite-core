// SPDX-License-Identifier: GPL-2.0-or-later

import { audioHeaderBytes, audioRead, audioWrite, audioClosed, audioDropped,
  audioUnderruns, audioRendered } from "./audio-ring";
import type { AudioTransport } from "./audio-ring";

export interface AudioOutputStatistics {
  sampleRate: number;
  state: AudioContextState;
  bufferedFrames: number;
  renderedFrames: number;
  droppedFrames: number;
  underruns: number;
  baseLatency: number;
  outputLatency: number;
}

/** Owned by AzaharClient; Web Audio resamples the native rate for the output device. */
export class BrowserAudioOutput {
  readonly #header: Int32Array<SharedArrayBuffer>;
  #closing: Promise<undefined> | undefined;

  private constructor(readonly context: AudioContext, readonly node: AudioWorkletNode,
    readonly transport: AudioTransport) {
    this.#header = new Int32Array(transport.buffer, 0, audioHeaderBytes / 4);
  }

  /** Call from a user gesture after the emulation worker is ready. */
  static async create(sampleRate: number, failed: (message: string) => unknown,
    signal?: AbortSignal): Promise<BrowserAudioOutput> {
    if (!globalThis.crossOriginIsolated) throw new Error("Shared audio requires cross-origin isolation");
    if (signal?.aborted) throw new Error("Audio connection was cancelled");
    const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
    let cancel: (() => undefined) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error("Audio connection was cancelled")); return undefined; };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      // Resume while the caller's user activation is still available.
      const resumed = context.resume();
      await Promise.race([Promise.all([resumed,
        context.audioWorklet.addModule(new URL("./azahar-audio-worklet.js", import.meta.url))]), cancelled]);
      const capacity = 4096;
      const transport: AudioTransport = {
        buffer: new SharedArrayBuffer(audioHeaderBytes + capacity * 4), capacity, sampleRate,
      };
      const node = new AudioWorkletNode(context, "azahar-audio", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: "explicit", processorOptions: transport,
      });
      node.onprocessorerror = () => failed("Azahar's audio worklet stopped");
      node.connect(context.destination);
      return new BrowserAudioOutput(context, node, transport);
    } catch (error) {
      await context.close();
      throw error;
    } finally { if (cancel) signal?.removeEventListener("abort", cancel); }
  }

  async resume(): Promise<undefined> { await this.context.resume(); return undefined; }
  async suspend(): Promise<undefined> { await this.context.suspend(); return undefined; }

  statistics(): AudioOutputStatistics {
    const read = Atomics.load(this.#header, audioRead) >>> 0;
    const write = Atomics.load(this.#header, audioWrite) >>> 0;
    return { sampleRate: this.context.sampleRate, state: this.context.state,
      bufferedFrames: (write - read) >>> 0,
      renderedFrames: Atomics.load(this.#header, audioRendered) >>> 0,
      droppedFrames: Atomics.load(this.#header, audioDropped) >>> 0,
      underruns: Atomics.load(this.#header, audioUnderruns) >>> 0,
      baseLatency: this.context.baseLatency, outputLatency: this.context.outputLatency };
  }

  close(): Promise<undefined> {
    if (this.#closing) return this.#closing;
    Atomics.store(this.#header, audioClosed, 1);
    this.node.disconnect();
    this.node.port.close();
    this.#closing = this.context.close().then(() => undefined);
    return this.#closing;
  }
}
