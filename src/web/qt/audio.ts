// SPDX-License-Identifier: GPL-2.0-or-later

import { AudioProducer, audioClosed, audioHeaderBytes, audioRead, audioWrite } from "../runtime/audio-ring";
import type { AudioTransport } from "../runtime/audio-ring";

/** Refill from Azahar's native volume and time-stretch callback once per video frame. */
export class QtAudioProducer extends AudioProducer {
  readonly #header: Int32Array<SharedArrayBuffer>;
  #running = false;

  constructor(transport: AudioTransport) {
    super(transport);
    this.#header = new Int32Array(transport.buffer, 0, audioHeaderBytes / 4);
  }

  requestedFrames(): number {
    if (!this.#running || Atomics.load(this.#header, audioClosed)) return 0;
    const occupied = (Atomics.load(this.#header, audioWrite) - Atomics.load(this.#header, audioRead)) >>> 0;
    if (occupied > this.transport.capacity) throw new Error("Invalid shared audio cursors");
    // Two video frames plus scheduling headroom, without filling the whole transport.
    return Math.max(0, Math.min(2048, this.transport.capacity) - occupied);
  }

  resume(): undefined {
    this.clear();
    this.#running = true;
    return undefined;
  }
}
