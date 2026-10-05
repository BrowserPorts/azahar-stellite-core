// SPDX-License-Identifier: GPL-2.0-or-later

export const audioHeaderBytes = 64;
export const audioRead = 0;
export const audioWrite = 1;
export const audioResetCursor = 2;
export const audioEpoch = 3;
export const audioClosed = 4;
export const audioDropped = 5;
export const audioUnderruns = 6;
export const audioRendered = 7;

export interface AudioTransport {
  buffer: SharedArrayBuffer;
  capacity: number;
  sampleRate: number;
}

/** One emulation worker produces interleaved PCM; one audio worklet consumes it. */
export class AudioProducer {
  readonly #header: Int32Array<SharedArrayBuffer>;
  readonly #samples: Int16Array<SharedArrayBuffer>;

  constructor(readonly transport: AudioTransport) {
    const { buffer, capacity, sampleRate } = transport;
    if (!(buffer instanceof SharedArrayBuffer) || !Number.isInteger(capacity) ||
      capacity < 2048 || capacity > 32768 || (capacity & (capacity - 1)) ||
      buffer.byteLength !== audioHeaderBytes + capacity * 4 ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
      throw new Error("Invalid shared audio transport");
    }
    this.#header = new Int32Array(buffer, 0, audioHeaderBytes / 4);
    this.#samples = new Int16Array(buffer, audioHeaderBytes);
  }

  write(samples: Int16Array<SharedArrayBuffer>, sampleRate: number): undefined {
    if (sampleRate !== this.transport.sampleRate || samples.length % 2) {
      throw new Error("Native audio format changed");
    }
    if (Atomics.load(this.#header, audioClosed)) return undefined;
    const read = Atomics.load(this.#header, audioRead) >>> 0;
    const write = Atomics.load(this.#header, audioWrite) >>> 0;
    const occupied = (write - read) >>> 0;
    if (occupied > this.transport.capacity) throw new Error("Invalid shared audio cursors");
    const frames = Math.min(samples.length / 2, this.transport.capacity - occupied);
    const offset = write & (this.transport.capacity - 1);
    const first = Math.min(frames, this.transport.capacity - offset);
    this.#samples.set(samples.subarray(0, first * 2), offset * 2);
    if (frames > first) this.#samples.set(samples.subarray(first * 2, frames * 2), 0);
    // Publish only after every sample in this batch has been copied.
    Atomics.store(this.#header, audioWrite, (write + frames) | 0);
    if (frames < samples.length / 2) Atomics.add(this.#header, audioDropped, samples.length / 2 - frames);
    return undefined;
  }

  clear(): undefined {
    // The consumer alone advances its read cursor, including on seeks and pauses.
    Atomics.add(this.#header, audioEpoch, 1);
    Atomics.store(this.#header, audioResetCursor, Atomics.load(this.#header, audioWrite));
    Atomics.add(this.#header, audioEpoch, 1);
    return undefined;
  }

  close(): undefined {
    Atomics.store(this.#header, audioClosed, 1);
    return undefined;
  }
}
