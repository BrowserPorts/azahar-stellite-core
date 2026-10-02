// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../arm/jit-host";
import { PicaJitHost } from "../pica/jit-host";
import type { GraphicsClient } from "../gpu/client";
import type { AzaharModule, AzaharModuleFactory } from "./module";
import { OpfsSaveStates } from "./save-states";

export interface SessionOutput {
  video(bytes: Uint8Array<SharedArrayBuffer>, width: number, height: number, pitch: number): unknown;
  audio(samples: Int16Array<SharedArrayBuffer>): unknown;
  log(line: string): unknown;
}

export interface InputState {
  buttons: number;
  circleX: number;
  circleY: number;
  cstickX: number;
  cstickY: number;
  touchX: number;
  touchY: number;
  touchPressed: boolean;
}

/** All native entry points are called between frames on the emulation worker. */
export class BrowserSession {
  #states: OpfsSaveStates | undefined;
  #loaded = false;
  #closed = false;
  #mounted = false;

  private constructor(readonly core: AzaharModule) {}

  static async create(factory: AzaharModuleFactory, output: SessionOutput,
    graphics: GraphicsClient): Promise<BrowserSession> {
    if (!globalThis.crossOriginIsolated) {
      throw new Error("Azahar requires Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers");
    }
    const core = await factory({
      azaharJitHost: new ArmJitHost(),
      azaharPicaJitHost: new PicaJitHost(),
      azaharGraphicsHost: graphics,
      print: output.log,
      printErr: output.log,
      azaharVideo: (pointer, width, height, pitch) => {
        if (pointer > 0 && pointer !== 0xffffffff) {
          output.video(core.HEAPU8.subarray(pointer, pointer + pitch * height), width, height, pitch);
        }
      },
      azaharAudio: (pointer, frames) => output.audio(core.HEAP16.subarray(pointer >>> 1,
        (pointer >>> 1) + frames * 2)),
    });
    if (core._azahar_web_abi() !== 1) throw new Error("Unsupported Azahar browser ABI");
    core.FS.mkdirTree("/user");
    core.FS.mkdirTree("/rom");
    if (!core._azahar_initialize()) throw new Error("Azahar initialization failed");
    return new BrowserSession(core);
  }

  async load(file: File): Promise<string> {
    this.checkOpen();
    if (this.#loaded) throw new Error("Close the current session before loading another game");
    if (!file.size || /[/\\\0]/.test(file.name)) throw new Error("Invalid game file");
    this.core.FS.mount(this.core.WORKERFS, { files: [file] }, "/rom");
    this.#mounted = true;
    const path = this.core.stringToNewUTF8(`/rom/${file.name}`);
    try {
      if (!this.core._azahar_load_game(path)) throw new Error("Azahar could not load this game");
      this.#loaded = true;
      let game = this.core.UTF8ToString(this.core._azahar_program_id());
      if (game === "0000000000000000") {
        // Homebrew loaders may have no title ID; use the file's content identity.
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        game = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      this.#states = await OpfsSaveStates.open(game);
      return game;
    } catch (error) {
      // A partially loaded kernel must not receive another load request.
      this.close();
      throw error;
    } finally {
      this.core._free(path);
    }
  }

  runFrame(): undefined {
    this.checkLoaded();
    if (!this.core._azahar_run_frame()) throw new Error("Azahar stopped running");
    return undefined;
  }

  input(value: InputState): undefined {
    this.checkOpen();
    if (!Number.isInteger(value.buttons) || value.buttons < 0 || value.buttons > 0xffff ||
      ![value.circleX, value.circleY, value.cstickX, value.cstickY, value.touchX, value.touchY]
        .every((axis) => Number.isInteger(axis) && axis >= -32768 && axis <= 32767) ||
      typeof value.touchPressed !== "boolean") throw new Error("Invalid input state");
    this.core._azahar_set_input(value.buttons, value.circleX, value.circleY,
      value.cstickX, value.cstickY, value.touchX, value.touchY, Number(value.touchPressed));
    return undefined;
  }

  save(slot: number): Promise<number> {
    this.checkLoaded();
    if (!this.#states) throw new Error("Save-state storage is unavailable");
    return this.#states.save(slot, this.core);
  }

  restore(slot: number): Promise<number> {
    this.checkLoaded();
    if (!this.#states) throw new Error("Save-state storage is unavailable");
    return this.#states.load(slot, this.core);
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    this.core._azahar_shutdown();
    if (this.#mounted) this.core.FS.unmount("/rom");
    this.#mounted = false;
    this.#loaded = false;
    this.#states = undefined;
    return undefined;
  }

  private checkOpen(): undefined {
    if (this.#closed) throw new Error("The Azahar session is closed");
    return undefined;
  }

  private checkLoaded(): undefined {
    this.checkOpen();
    if (!this.#loaded) throw new Error("No game is loaded");
    return undefined;
  }
}
