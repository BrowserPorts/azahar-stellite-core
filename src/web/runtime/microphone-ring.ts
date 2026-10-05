// SPDX-License-Identifier: GPL-2.0-or-later

export const microphoneRate = 48000;
export const microphoneHeaderBytes = 64;
export const microphoneCapacity = 4096;
export const micRead = 0;
export const micWrite = 1;
export const micEnabled = 2;
export const micClosed = 3;
export const micEpoch = 4;
export const micPublishedEpoch = 5;
export const micResetCursor = 6;
export const micDropped = 7;

export interface MicrophoneTransport { buffer: SharedArrayBuffer }

/** One audio worklet produces mono PCM; native microphone polling consumes it. */
export class MicrophoneConsumer {
  #header: Int32Array<SharedArrayBuffer> | undefined;
  #samples: Int16Array<SharedArrayBuffer> | undefined;
  #active = false;
  #running = false;
  #epoch = -1;

  attach(transport: MicrophoneTransport): undefined {
    const buffer = transport?.buffer;
    if (!(buffer instanceof SharedArrayBuffer) ||
      buffer.byteLength !== microphoneHeaderBytes + microphoneCapacity * 2) {
      throw new Error("Invalid shared microphone transport");
    }
    if (this.#header && !Atomics.load(this.#header, micClosed)) {
      throw new Error("Browser microphone is already connected");
    }
    this.#header = new Int32Array(buffer, 0, microphoneHeaderBytes / 4);
    this.#samples = new Int16Array(buffer, microphoneHeaderBytes);
    this.#epoch = -1;
    this.reset();
    return undefined;
  }

  active(value: boolean): undefined { this.#active = value; return this.reset(); }
  running(value: boolean): undefined { this.#running = value; return this.reset(); }

  private reset(): undefined {
    if (this.#header) {
      Atomics.store(this.#header, micEnabled, Number(this.#active && this.#running));
      Atomics.add(this.#header, micEpoch, 1);
      Atomics.store(this.#header, micRead, Atomics.load(this.#header, micWrite));
    }
    return undefined;
  }

  read(destination: Int16Array<SharedArrayBuffer>): number {
    const header = this.#header;
    if (!header || !this.#samples || !Atomics.load(header, micEnabled) || Atomics.load(header, micClosed)) return 0;
    const epoch = Atomics.load(header, micEpoch);
    // Acknowledge resets on the producer before accepting its next samples.
    if (Atomics.load(header, micPublishedEpoch) !== epoch) return 0;
    if (this.#epoch !== epoch) {
      Atomics.store(header, micRead, Atomics.load(header, micResetCursor));
      this.#epoch = epoch;
    }
    const read = Atomics.load(header, micRead) >>> 0;
    const write = Atomics.load(header, micWrite) >>> 0;
    const available = (write - read) >>> 0;
    if (available > microphoneCapacity) throw new Error("Invalid shared microphone cursors");
    const count = Math.min(available, destination.length);
    const offset = read & (microphoneCapacity - 1);
    const first = Math.min(count, microphoneCapacity - offset);
    destination.set(this.#samples.subarray(offset, offset + first));
    if (count > first) destination.set(this.#samples.subarray(0, count - first), first);
    Atomics.store(header, micRead, (read + count) | 0);
    return count;
  }

  close(): undefined {
    if (this.#header) Atomics.store(this.#header, micClosed, 1);
    this.#header = undefined;
    this.#samples = undefined;
    return undefined;
  }
}
