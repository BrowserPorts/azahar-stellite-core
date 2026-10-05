// SPDX-License-Identifier: GPL-2.0-or-later

import type { MotionState } from "./session";

/** Device-motion capture owned by one AzaharClient. */
export class BrowserMotionInput {
  #closed = false;
  #closing: Promise<undefined> | undefined;
  #latest: MotionState | null | undefined;
  #sending = false;
  #idle: Promise<undefined> = Promise.resolve(undefined);
  #timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(private readonly send: (state: MotionState | null) => Promise<undefined>,
    private readonly failed: (message: string) => unknown, private readonly signal: AbortSignal) {
    window.addEventListener("devicemotion", this.onMotion);
    document.addEventListener("visibilitychange", this.onVisibility);
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Call from a user gesture so browsers can request sensor permission. */
  static async create(send: (state: MotionState | null) => Promise<undefined>,
    failed: (message: string) => unknown, signal: AbortSignal): Promise<BrowserMotionInput> {
    if (!globalThis.isSecureContext || typeof globalThis.DeviceMotionEvent !== "function") {
      throw new Error("Device motion requires a secure browser with sensor support");
    }
    if (signal.aborted) throw new Error("Motion connection was cancelled");
    const motion = DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    let cancel: (() => undefined) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error("Motion connection was cancelled")); return undefined; };
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const permission = await Promise.race([motion.requestPermission?.() ?? "granted", cancelled]);
      if (permission !== "granted") throw new Error("Motion sensor permission was denied");
      if (signal.aborted) throw new Error("Motion connection was cancelled");
      return new BrowserMotionInput(send, failed, signal);
    } finally { if (cancel) signal.removeEventListener("abort", cancel); }
  }

  /** True after listeners are detached and outstanding samples have finished. */
  get closed(): boolean { return this.#closed && !this.#sending; }

  /** Detach listeners and restore stationary, screen-up motion input. */
  close(): Promise<undefined> {
    if (this.#closing) return this.#closing;
    this.detach();
    this.#closing = this.queue(null);
    return this.#closing;
  }

  private readonly onMotion = (event: DeviceMotionEvent): undefined => {
    if (this.#closed || document.hidden) return undefined;
    const a = event.accelerationIncludingGravity;
    const r = event.rotationRate;
    const finite = (value: number | null | undefined): value is number =>
      typeof value === "number" && Number.isFinite(value);
    const acceleration = a && finite(a.x) && finite(a.y) && finite(a.z)
      ? { x: a.x, y: a.y, z: a.z } : undefined;
    const rotationRate = r && finite(r.alpha) && finite(r.beta) && finite(r.gamma)
      ? { alpha: r.alpha, beta: r.beta, gamma: r.gamma } : undefined;
    if (!acceleration && !rotationRate) {
      this.close().catch(error => this.failed(String(error)));
      this.failed("The device did not provide motion sensor data");
      return undefined;
    }
    const angle = ((screen.orientation.angle % 360) + 360) % 360;
    if (angle !== 0 && angle !== 90 && angle !== 180 && angle !== 270) return undefined;
    this.submit({ acceleration: acceleration ?? { x: 0, y: 0, z: 9.80665 },
      rotationRate: rotationRate ?? { alpha: 0, beta: 0, gamma: 0 }, screenAngle: angle });
    clearTimeout(this.#timer);
    // Stop integrating an old angular velocity if sensor events cease.
    this.#timer = setTimeout(() => this.submit(null), 1000);
    return undefined;
  };

  private readonly onVisibility = (): undefined => {
    if (document.hidden) { clearTimeout(this.#timer); this.submit(null); }
    return undefined;
  };

  private readonly onAbort = (): undefined => {
    this.detach();
    return undefined;
  };

  private detach(): undefined {
    this.#closed = true;
    this.#latest = undefined;
    clearTimeout(this.#timer);
    window.removeEventListener("devicemotion", this.onMotion);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.signal.removeEventListener("abort", this.onAbort);
    return undefined;
  }

  private submit(state: MotionState | null): undefined {
    this.queue(state).catch(error => {
      if (!this.signal.aborted && !this.#closed) { this.detach(); this.failed(String(error)); }
    });
    return undefined;
  }

  private queue(state: MotionState | null): Promise<undefined> {
    if (this.signal.aborted) return Promise.resolve(undefined);
    this.#latest = state;
    if (this.#sending) return this.#idle;
    this.#sending = true;
    this.#idle = (async () => {
      try {
        // Keep only the newest sample while the worker finishes the current frame.
        while (this.#latest !== undefined && !this.signal.aborted) {
          const next = this.#latest;
          this.#latest = undefined;
          await this.send(next);
        }
      } finally { this.#sending = false; }
      return undefined;
    })();
    return this.#idle;
  }
}
