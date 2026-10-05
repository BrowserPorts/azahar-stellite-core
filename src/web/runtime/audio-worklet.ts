// SPDX-License-Identifier: GPL-2.0-or-later

import { audioHeaderBytes, audioRead, audioWrite, audioResetCursor, audioEpoch,
  audioClosed, audioUnderruns, audioRendered } from "./audio-ring";
import type { AudioTransport } from "./audio-ring";

declare const AudioWorkletProcessor: {
  new(options: AudioWorkletNodeOptions): { readonly port: MessagePort };
};
declare function registerProcessor(name: string,
  processor: new(options: AudioWorkletNodeOptions) => AzaharAudioProcessor): undefined;

class AzaharAudioProcessor extends AudioWorkletProcessor {
  readonly #header: Int32Array<SharedArrayBuffer>;
  readonly #samples: Int16Array<SharedArrayBuffer>;
  readonly #mask: number;
  #epoch = -1;
  #playing = false;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const { buffer, capacity } = options.processorOptions as AudioTransport;
    this.#header = new Int32Array(buffer, 0, audioHeaderBytes / 4);
    this.#samples = new Int16Array(buffer, audioHeaderBytes);
    this.#mask = capacity - 1;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!left || !right || Atomics.load(this.#header, audioClosed)) return false;
    const epoch = Atomics.load(this.#header, audioEpoch);
    if (epoch & 1) return true;
    let read = Atomics.load(this.#header, audioRead) >>> 0;
    if (epoch !== this.#epoch) {
      read = Atomics.load(this.#header, audioResetCursor) >>> 0;
      // A reset cursor belongs to the epoch that published it.
      if (Atomics.load(this.#header, audioEpoch) !== epoch) return true;
      this.#epoch = epoch;
      Atomics.store(this.#header, audioRead, read | 0);
      this.#playing = false;
    }
    const write = Atomics.load(this.#header, audioWrite) >>> 0;
    if (Atomics.load(this.#header, audioEpoch) !== epoch) return true;
    const available = (write - read) >>> 0;
    // Buffer two native frames before starting or recovering from an underrun.
    if (!this.#playing && available >= 1024) this.#playing = true;
    const frames = this.#playing ? Math.min(available, left.length) : 0;
    for (let frame = 0; frame < frames; frame++) {
      const offset = ((read + frame) & this.#mask) * 2;
      left[frame] = this.#samples[offset]! / 32768;
      right[frame] = this.#samples[offset + 1]! / 32768;
    }
    left.fill(0, frames);
    right.fill(0, frames);
    if (this.#playing && frames < left.length) {
      Atomics.add(this.#header, audioUnderruns, 1);
      this.#playing = false;
    }
    if (frames) {
      Atomics.store(this.#header, audioRead, (read + frames) | 0);
      Atomics.add(this.#header, audioRendered, frames);
    }
    return true;
  }
}

registerProcessor("azahar-audio", AzaharAudioProcessor);
