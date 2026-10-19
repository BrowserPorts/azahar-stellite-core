// SPDX-License-Identifier: GPL-2.0-or-later

export interface OptimizerSignal { memory: SharedArrayBuffer; offset: number; }

export interface OptimizerBuffers {
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  signal?: OptimizerSignal;
}

export interface OptimizedInstruction {
  key: number;
  bytes: Uint8Array<ArrayBuffer>;
  elapsedMs: number;
  foldedLoads: number;
  error: boolean;
}

const headerBytes = 24;

/** One optimizer writes complete records; its owning DSP thread consumes them. */
export class OptimizerMailbox {
  readonly #control: Int32Array<SharedArrayBuffer>;
  readonly #data: Uint8Array<SharedArrayBuffer>;
  readonly #signal: Int32Array<SharedArrayBuffer> | undefined;

  constructor(readonly buffers: OptimizerBuffers = {
    control: new SharedArrayBuffer(16), data: new SharedArrayBuffer(1024 * 1024),
  }, signal = buffers.signal) {
    this.#control = new Int32Array(buffers.control);
    this.#data = new Uint8Array(buffers.data);
    if (signal) buffers.signal = signal;
    this.#signal = signal ? new Int32Array(signal.memory, signal.offset, 1) : undefined;
  }

  get closed(): boolean { return Atomics.load(this.#control, 2) !== 0; }
  get failed(): boolean { return Atomics.load(this.#control, 3) !== 0; }
  get sequence(): number { return Atomics.load(this.#control, 0); }
  get hasResults(): boolean { return Atomics.load(this.#control, 1) !== this.sequence; }

  private signal(): undefined {
    if (this.#signal) Atomics.store(this.#signal, 0, 1);
    return undefined;
  }

  /** Backpressure sleeps only the compiler worker, leaving emulation runnable. */
  write(result: OptimizedInstruction): undefined {
    const record = new Uint8Array(headerBytes + result.bytes.byteLength);
    if (record.byteLength > this.#data.byteLength) throw new Error("Optimized DSP entry exceeds the result queue capacity");
    const view = new DataView(record.buffer);
    view.setUint32(0, result.key, true);
    view.setUint32(4, result.bytes.byteLength, true);
    view.setFloat64(8, result.elapsedMs, true);
    view.setUint32(16, result.foldedLoads, true);
    view.setUint32(20, Number(result.error), true);
    record.set(result.bytes, headerBytes);
    const written = this.sequence >>> 0;
    while (!this.closed) {
      const read = Atomics.load(this.#control, 1);
      const used = (written - (read >>> 0)) >>> 0;
      if (record.byteLength <= this.#data.byteLength - used) {
        const offset = written % this.#data.byteLength;
        const first = Math.min(record.byteLength, this.#data.byteLength - offset);
        this.#data.set(record.subarray(0, first), offset);
        this.#data.set(record.subarray(first), 0);
        Atomics.store(this.#control, 0, (written + record.byteLength) | 0);
        this.signal();
        Atomics.notify(this.#control, 0);
        return undefined;
      }
      Atomics.wait(this.#control, 1, read);
    }
    return undefined;
  }

  read(): OptimizedInstruction | undefined {
    const read = Atomics.load(this.#control, 1) >>> 0;
    const available = ((this.sequence >>> 0) - read) >>> 0;
    if (!available) return undefined;
    const copy = (offset: number, size: number): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(size);
      const start = offset % this.#data.byteLength;
      const first = Math.min(size, this.#data.byteLength - start);
      bytes.set(this.#data.subarray(start, start + first));
      bytes.set(this.#data.subarray(0, size - first), first);
      return bytes;
    };
    if (available < headerBytes || available > this.#data.byteLength) throw new Error("Invalid DSP result queue length");
    const header = new DataView(copy(read, headerBytes).buffer);
    const size = header.getUint32(4, true);
    if (headerBytes + size > available) throw new Error("Truncated optimized DSP entry");
    const bytes = copy(read + headerBytes, size);
    Atomics.store(this.#control, 1, (read + headerBytes + size) | 0);
    Atomics.notify(this.#control, 1);
    return { key: header.getUint32(0, true), bytes, elapsedMs: header.getFloat64(8, true),
      foldedLoads: header.getUint32(16, true), error: header.getUint32(20, true) !== 0 };
  }

  async wait(sequence: number): Promise<undefined> {
    const result = Atomics.waitAsync(this.#control, 0, sequence, 1000);
    if (result.async) await result.value;
    return undefined;
  }

  fail(): undefined {
    Atomics.store(this.#control, 3, 1);
    this.signal();
    Atomics.notify(this.#control, 0);
    return undefined;
  }

  close(): undefined {
    Atomics.store(this.#control, 2, 1);
    // Change the waited-on value as well, covering a compiler about to sleep.
    Atomics.add(this.#control, 1, 1);
    Atomics.notify(this.#control, 0);
    Atomics.notify(this.#control, 1);
    return undefined;
  }
}
