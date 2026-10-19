// SPDX-License-Identifier: GPL-2.0-or-later

import { checkInputState } from "./input-state";
import type { InputState } from "./input-state";

export interface BrowserInputOptions {
  /** Poll standard gamepads while the canvas has focus; enabled by default. */
  gamepads?: boolean;
  /** Default to the first connected standard gamepad. */
  gamepadIndex?: number;
  /** Radial deadzone in [0, 1), defaulting to 0.15. */
  gamepadDeadzone?: number;
}

// QtConfig::default_buttons, translated to the native LibRetro button mask.
const buttons: Readonly<Record<string, number>> = {
  KeyA: 1 << 8, KeyS: 1 << 0, KeyZ: 1 << 9, KeyX: 1 << 1,
  KeyT: 1 << 4, KeyG: 1 << 5, KeyF: 1 << 6, KeyH: 1 << 7,
  KeyQ: 1 << 10, KeyW: 1 << 11, KeyM: 1 << 3, KeyN: 1 << 2,
  Digit1: 1 << 12, Digit2: 1 << 13,
};
const analogKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyI", "KeyK", "KeyJ", "KeyL", "KeyD"]);
// W3C standard gamepad positions, translated to the native LibRetro button IDs.
const gamepadButtons = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];
const neutral = (): InputState => ({ buttons: 0, circleX: 0, circleY: 0,
  cstickX: 0, cstickY: 0, touchX: 0, touchY: 0, touchPressed: false });

/** Keyboard, pointer and gamepad capture owned by one canvas and one AzaharClient. */
export class BrowserInput {
  #keys = new Set<string>();
  #pointer: number | undefined;
  #touchX = 0;
  #touchY = 0;
  #host = neutral();
  #closed = false;
  #sending = false;
  #latest: InputState | undefined;
  #idle: Promise<undefined> = Promise.resolve(undefined);
  #closing: Promise<undefined> | undefined;
  #focused = false;
  #frame: number | undefined;
  #last: InputState | undefined;
  readonly #addedTabIndex: boolean;
  readonly #touchAction: string;
  readonly #touchPriority: string;

  private constructor(private readonly canvas: HTMLCanvasElement,
    private readonly send: (state: InputState) => Promise<undefined>,
    private readonly failed: (message: string) => unknown, private readonly signal: AbortSignal,
    private gamepads: boolean, private readonly gamepadIndex: number | undefined,
    private readonly gamepadDeadzone: number) {
    this.#addedTabIndex = !canvas.hasAttribute("tabindex");
    if (this.#addedTabIndex) canvas.tabIndex = 0;
    this.#touchAction = canvas.style.getPropertyValue("touch-action");
    this.#touchPriority = canvas.style.getPropertyPriority("touch-action");
    canvas.style.setProperty("touch-action", "none");
    canvas.addEventListener("keydown", this.onKey);
    canvas.addEventListener("keyup", this.onKey);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerEnd);
    canvas.addEventListener("pointercancel", this.onPointerEnd);
    canvas.addEventListener("lostpointercapture", this.onPointerEnd);
    canvas.addEventListener("focus", this.onFocus);
    canvas.addEventListener("blur", this.release);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("visibilitychange", this.onVisibility);
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.onFocus();
  }

  static create(canvas: HTMLCanvasElement, send: (state: InputState) => Promise<undefined>,
    failed: (message: string) => unknown, signal: AbortSignal,
    options: BrowserInputOptions = {}): BrowserInput {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.ownerDocument !== document) {
      throw new Error("Browser input requires a canvas in this document");
    }
    if (signal.aborted) throw new Error("Input connection was cancelled");
    const deadzone = options.gamepadDeadzone ?? 0.15;
    if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone >= 1 ||
      (options.gamepadIndex !== undefined &&
        (!Number.isSafeInteger(options.gamepadIndex) || options.gamepadIndex < 0)) ||
      (options.gamepads !== undefined && typeof options.gamepads !== "boolean")) {
      throw new Error("Invalid browser gamepad options");
    }
    return new BrowserInput(canvas, send, failed, signal, options.gamepads ?? true,
      options.gamepadIndex, deadzone);
  }

  get closed(): boolean { return this.#closed && !this.#sending; }

  /** Apply the current browser input before manually advancing a frame. */
  flush(): Promise<undefined> {
    if (this.#closed) throw new Error("Browser input is closed");
    return this.publish();
  }

  /** Preserve host controls across canvas focus changes and local input updates. */
  setHostInput(state: InputState): Promise<undefined> {
    if (this.#closed) throw new Error("Browser input is closed");
    checkInputState(state);
    this.#host = document.hidden ? neutral() : { ...state };
    return this.publish();
  }

  /** Detach listeners and release held controls before resolving. */
  close(): Promise<undefined> {
    if (this.#closing) return this.#closing;
    this.detach();
    this.#closing = this.signal.aborted ? this.#idle : this.queue(neutral());
    return this.#closing;
  }

  private readonly onKey = (event: KeyboardEvent): undefined => {
    if (this.#closed || document.hidden ||
      (buttons[event.code] === undefined && !analogKeys.has(event.code))) return undefined;
    if (event.type === "keydown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
      this.#keys.add(event.code);
    } else this.#keys.delete(event.code);
    event.preventDefault();
    this.publish();
    return undefined;
  };

  private readonly onPointerDown = (event: PointerEvent): undefined => {
    if (this.#closed || document.hidden || !event.isPrimary || event.button !== 0 ||
      this.#pointer !== undefined) return undefined;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(event.pointerId);
    this.#pointer = event.pointerId;
    return this.onPointerMove(event);
  };

  private readonly onPointerMove = (event: PointerEvent): undefined => {
    if (this.#closed || this.#pointer !== event.pointerId) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const coordinate = (value: number): number =>
      Math.round((Math.max(0, Math.min(1, value)) * 2 - 1) * 32767);
    this.#touchX = coordinate((event.clientX - rect.left) / rect.width);
    this.#touchY = coordinate((event.clientY - rect.top) / rect.height);
    event.preventDefault();
    this.publish();
    return undefined;
  };

  private readonly onPointerEnd = (event: PointerEvent): undefined => {
    if (this.#closed || this.#pointer !== event.pointerId) return undefined;
    this.releasePointer();
    this.publish();
    return undefined;
  };

  private readonly release = (): undefined => {
    this.#focused = false;
    this.stopPolling();
    this.#keys.clear();
    this.releasePointer();
    if (!this.#closed) this.publish();
    return undefined;
  };

  private readonly onVisibility = (): undefined => {
    if (document.hidden) this.releaseAll();
    else this.onFocus();
    return undefined;
  };

  private readonly releaseAll = (): undefined => {
    this.#host = neutral();
    this.release();
    return undefined;
  };

  private readonly onFocus = (): undefined => {
    if (this.#closed) return undefined;
    this.#focused = document.activeElement === this.canvas && !document.hidden && document.hasFocus();
    this.publish();
    this.startPolling();
    return undefined;
  };

  private readonly poll = (): undefined => {
    this.#frame = undefined;
    if (!this.#closed && this.#focused) { this.publish(); this.startPolling(); }
    return undefined;
  };

  private startPolling(): undefined {
    if (this.gamepads && this.#focused && this.#frame === undefined) {
      this.#frame = requestAnimationFrame(this.poll);
    }
    return undefined;
  }

  private stopPolling(): undefined {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    return undefined;
  }

  private readonly onAbort = (): undefined => { this.detach(); return undefined; };

  private releasePointer(): undefined {
    const pointer = this.#pointer;
    this.#pointer = undefined;
    if (pointer !== undefined && this.canvas.hasPointerCapture(pointer)) {
      this.canvas.releasePointerCapture(pointer);
    }
    return undefined;
  }

  private detach(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    this.#focused = false;
    this.stopPolling();
    this.#latest = undefined;
    this.#keys.clear();
    this.#host = neutral();
    this.releasePointer();
    this.canvas.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("keyup", this.onKey);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerEnd);
    this.canvas.removeEventListener("pointercancel", this.onPointerEnd);
    this.canvas.removeEventListener("lostpointercapture", this.onPointerEnd);
    this.canvas.removeEventListener("focus", this.onFocus);
    this.canvas.removeEventListener("blur", this.release);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.signal.removeEventListener("abort", this.onAbort);
    if (this.#addedTabIndex && this.canvas.getAttribute("tabindex") === "0") this.canvas.removeAttribute("tabindex");
    if (this.canvas.style.getPropertyValue("touch-action") === "none") {
      this.canvas.style.setProperty("touch-action", this.#touchAction, this.#touchPriority);
    }
    return undefined;
  }

  private readGamepad(): Gamepad | undefined {
    if (!this.#focused || !this.gamepads) return undefined;
    try {
      for (const pad of navigator.getGamepads()) {
        if (pad?.connected && pad.mapping === "standard" &&
          (this.gamepadIndex === undefined || pad.index === this.gamepadIndex)) return pad;
      }
    } catch (error) {
      this.gamepads = false;
      this.failed(`Browser gamepads are unavailable: ${String(error)}`);
    }
    return undefined;
  }

  private publish(): Promise<undefined> {
    const state = neutral();
    for (const code of this.#keys) state.buttons |= buttons[code] ?? 0;
    const stick = (left: string, right: string, up: string, down: string): [number, number] => {
      const x = Number(this.#keys.has(right)) - Number(this.#keys.has(left));
      const y = Number(this.#keys.has(down)) - Number(this.#keys.has(up));
      const scale = (this.#keys.has("KeyD") ? 0.5 : 1) * 32767 / Math.max(1, Math.hypot(x, y));
      return [Math.round(x * scale), Math.round(y * scale)];
    };
    [state.circleX, state.circleY] = stick("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown");
    [state.cstickX, state.cstickY] = stick("KeyJ", "KeyL", "KeyI", "KeyK");
    const pad = this.readGamepad();
    if (pad) {
      for (let index = 0; index < gamepadButtons.length; index++) {
        if (pad.buttons[index]?.pressed) state.buttons |= 1 << gamepadButtons[index]!;
      }
      const analog = (offset: number): [number, number] => {
        const x = pad.axes[offset] ?? 0;
        const y = pad.axes[offset + 1] ?? 0;
        const radius = Math.hypot(x, y);
        if (radius <= this.gamepadDeadzone) return [0, 0];
        // Native SDLAnalog's radial deadzone, bounded to the 3DS circle pad's travel.
        const scale = Math.min(1, (radius - this.gamepadDeadzone) /
          (1 - this.gamepadDeadzone)) * 32767 / radius;
        return [Math.round(x * scale), Math.round(y * scale)];
      };
      const [x, y] = analog(0);
      if (Math.hypot(x, y) > Math.hypot(state.circleX, state.circleY)) {
        state.circleX = x; state.circleY = y;
      }
      const [cx, cy] = analog(2);
      if (Math.hypot(cx, cy) > Math.hypot(state.cstickX, state.cstickY)) {
        state.cstickX = cx; state.cstickY = cy;
      }
    }
    state.touchX = this.#touchX;
    state.touchY = this.#touchY;
    state.touchPressed = this.#pointer !== undefined;
    const host = this.#host;
    state.buttons |= host.buttons;
    if (Math.hypot(host.circleX, host.circleY) > Math.hypot(state.circleX, state.circleY)) {
      state.circleX = host.circleX; state.circleY = host.circleY;
    }
    if (Math.hypot(host.cstickX, host.cstickY) > Math.hypot(state.cstickX, state.cstickY)) {
      state.cstickX = host.cstickX; state.cstickY = host.cstickY;
    }
    if (!state.touchPressed && host.touchPressed) {
      state.touchX = host.touchX;
      state.touchY = host.touchY;
      state.touchPressed = true;
    }
    const previous = this.#last;
    if (previous && previous.buttons === state.buttons &&
      previous.circleX === state.circleX && previous.circleY === state.circleY &&
      previous.cstickX === state.cstickX && previous.cstickY === state.cstickY &&
      previous.touchX === state.touchX && previous.touchY === state.touchY &&
      previous.touchPressed === state.touchPressed) return this.#idle;
    this.#last = state;
    const pending = this.queue(state);
    pending.catch(error => {
      if (!this.signal.aborted && !this.#closed) { this.detach(); this.failed(String(error)); }
    });
    return pending;
  }

  private queue(state: InputState): Promise<undefined> {
    this.#latest = state;
    if (this.#sending) return this.#idle;
    this.#sending = true;
    this.#idle = (async () => {
      try {
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
