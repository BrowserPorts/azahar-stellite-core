// SPDX-License-Identifier: GPL-2.0-or-later

import { microphoneRate, microphoneHeaderBytes, microphoneCapacity, micClosed, micDropped } from "./microphone-ring";
import type { MicrophoneTransport } from "./microphone-ring";

/** Owns a permission-granted microphone and a silent capture worklet. */
export class BrowserMicrophoneInput {
  readonly #header: Int32Array<SharedArrayBuffer>;
  #closing: Promise<undefined> | undefined;

  private constructor(readonly context: AudioContext, readonly transport: MicrophoneTransport,
    private readonly stream: MediaStream, private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode, private readonly signal: AbortSignal,
    private readonly failed: (message: string) => unknown) {
    this.#header = new Int32Array(transport.buffer, 0, microphoneHeaderBytes / 4);
    signal.addEventListener("abort", this.onAbort, { once: true });
    context.addEventListener("statechange", this.onContextState);
    for (const track of stream.getTracks()) track.addEventListener("ended", this.onEnded);
    node.onprocessorerror = () => {
      this.onAbort();
      failed("Azahar's microphone worklet stopped");
    };
  }

  /** Call from a user gesture; Web Audio resamples the device to native 48 kHz PCM. */
  static async create(failed: (message: string) => unknown,
    signal: AbortSignal,
    workletUrl: URL | string = new URL("./azahar-microphone-worklet.js", import.meta.url)):
    Promise<BrowserMicrophoneInput> {
    if (!globalThis.isSecureContext || !globalThis.crossOriginIsolated || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture requires a secure, cross-origin isolated browser");
    }
    if (signal.aborted) throw new Error("Microphone connection was cancelled");
    const context = new AudioContext({ sampleRate: microphoneRate, latencyHint: "interactive" });
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let node: AudioWorkletNode | undefined;
    let released = false;
    let cancel: (() => undefined) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error("Microphone connection was cancelled")); return undefined; };
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      // Request and resume before awaiting, while user activation is available.
      const resumed = context.resume();
      const acquired = navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, sampleRate: microphoneRate, echoCancellation: false,
        noiseSuppression: false, autoGainControl: false,
      }, video: false }).then(value => {
        if (released || signal.aborted) {
          for (const track of value.getTracks()) track.stop();
          throw new Error("Microphone connection was cancelled");
        }
        stream = value;
        return value;
      });
      await Promise.race([Promise.all([acquired, resumed,
        context.audioWorklet.addModule(workletUrl)]), cancelled]);
      if (signal.aborted) throw new Error("Microphone connection was cancelled");
      if (!stream?.getAudioTracks().some(track => track.readyState === "live")) {
        throw new Error("The microphone did not provide an audio track");
      }
      const transport: MicrophoneTransport = {
        buffer: new SharedArrayBuffer(microphoneHeaderBytes + microphoneCapacity * 2),
      };
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "azahar-microphone", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
        processorOptions: transport,
      });
      source.connect(node);
      node.connect(context.destination);
      return new BrowserMicrophoneInput(context, transport, stream, source, node, signal, failed);
    } catch (error) {
      released = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      source?.disconnect();
      node?.disconnect();
      node?.port.close();
      await context.close();
      throw error;
    } finally { if (cancel) signal.removeEventListener("abort", cancel); }
  }

  get closed(): boolean { return Atomics.load(this.#header, micClosed) !== 0; }
  get droppedSamples(): number { return Atomics.load(this.#header, micDropped) >>> 0; }

  close(): Promise<undefined> {
    if (this.#closing) return this.#closing;
    Atomics.store(this.#header, micClosed, 1);
    this.signal.removeEventListener("abort", this.onAbort);
    this.context.removeEventListener("statechange", this.onContextState);
    for (const track of this.stream.getTracks()) {
      track.removeEventListener("ended", this.onEnded);
      track.stop();
    }
    this.source.disconnect();
    this.node.disconnect();
    this.node.port.close();
    this.#closing = this.context.state === "closed" ? Promise.resolve(undefined)
      : this.context.close().then(() => undefined);
    return this.#closing;
  }

  private readonly onAbort = (): undefined => {
    this.close().catch(error => this.failed(String(error)));
    return undefined;
  };
  private readonly onContextState = (): undefined => {
    if (this.context.state === "closed") this.onAbort();
    return undefined;
  };
  private readonly onEnded = (): undefined => {
    this.onAbort();
    this.failed("The microphone device disconnected");
    return undefined;
  };
}
