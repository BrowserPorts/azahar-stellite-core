// SPDX-License-Identifier: GPL-2.0-or-later

import { microphoneHeaderBytes, microphoneCapacity, micRead, micWrite, micEnabled,
  micClosed, micEpoch, micPublishedEpoch, micResetCursor, micDropped } from "./microphone-ring";
import type { MicrophoneTransport } from "./microphone-ring";

declare const AudioWorkletProcessor: {
  new(options: AudioWorkletNodeOptions): { readonly port: MessagePort };
};
declare function registerProcessor(name: string,
  processor: new(options: AudioWorkletNodeOptions) => AzaharMicrophoneProcessor): undefined;

class AzaharMicrophoneProcessor extends AudioWorkletProcessor {
  readonly #header: Int32Array<SharedArrayBuffer>;
  readonly #samples: Int16Array<SharedArrayBuffer>;
  #epoch = -1;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const { buffer } = options.processorOptions as MicrophoneTransport;
    this.#header = new Int32Array(buffer, 0, microphoneHeaderBytes / 4);
    this.#samples = new Int16Array(buffer, microphoneHeaderBytes);
  }

  process(inputs: Float32Array[][]): boolean {
    if (Atomics.load(this.#header, micClosed)) return false;
    const write = Atomics.load(this.#header, micWrite) >>> 0;
    const epoch = Atomics.load(this.#header, micEpoch);
    if (epoch !== this.#epoch) {
      Atomics.store(this.#header, micResetCursor, write | 0);
      Atomics.store(this.#header, micPublishedEpoch, epoch);
      this.#epoch = epoch;
    }
    const samples = inputs[0]?.[0];
    if (!samples || !Atomics.load(this.#header, micEnabled)) return true;
    const read = Atomics.load(this.#header, micRead) >>> 0;
    const occupied = (write - read) >>> 0;
    if (occupied > microphoneCapacity) return true;
    const count = Math.min(samples.length, microphoneCapacity - occupied);
    for (let i = 0; i < count; i++) {
      const value = samples[i]!;
      this.#samples[(write + i) & (microphoneCapacity - 1)] = Number.isFinite(value)
        ? Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)) : 0;
    }
    Atomics.store(this.#header, micWrite, (write + count) | 0);
    if (count < samples.length) Atomics.add(this.#header, micDropped, samples.length - count);
    // The output remains silent; captured microphone audio is never played locally.
    return true;
  }
}

registerProcessor("azahar-microphone", AzaharMicrophoneProcessor);
