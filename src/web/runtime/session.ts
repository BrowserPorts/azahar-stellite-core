// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../arm/jit-host";
import type { ArmExecutionStatistics, ArmJitStatistics } from "../arm/jit-host";
import { PicaJitHost } from "../pica/jit-host";
import type { GraphicsClient, GraphicsStatistics } from "../gpu/client";
import type { AzaharModule, AzaharModuleFactory } from "./module";
import { OpfsSaveStates } from "./save-states";
import { UserStorageLock } from "./storage-lock";

export interface SessionOutput {
  video(bytes: Uint8Array<SharedArrayBuffer>, width: number, height: number, pitch: number): unknown;
  audio(samples: Int16Array<SharedArrayBuffer>, sampleRate: number): unknown;
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

/** Native frame averages and browser interval totals, including frame pacing time. */
export interface PerformanceStats {
  systemFps: number;
  gameFps: number;
  emulationSpeed: number;
  vblankMs: number;
  hleSvcMs: number;
  hleIpcMs: number;
  /** Time in native GPU command processing. */
  gpuCommandMs: number;
  swapMs: number;
  otherMs: number;
  /** Totals since the previous snapshot; excludes native IR translation. */
  armJit: ArmJitStatistics;
  /** Totals since the previous snapshot, rather than per-frame averages. */
  graphics: GraphicsStatistics;
}

/** All native entry points are called between frames on the emulation worker. */
export class BrowserSession {
  #states: OpfsSaveStates | undefined;
  #loaded = false;
  #closed = false;
  #gamePath = 0;
  #lastExecutionCounts = {
    nativeDispatches: 0n, completedBlocks: 0n,
    budgetReuses: 0n, fastDispatchHits: 0n,
  };

  private constructor(readonly core: AzaharModule, private readonly storage: UserStorageLock,
    private readonly armJit: ArmJitHost, private readonly graphics: GraphicsClient) {}

  static async create(factory: AzaharModuleFactory, output: SessionOutput,
    graphics: GraphicsClient): Promise<BrowserSession> {
    if (!globalThis.crossOriginIsolated) {
      throw new Error("Azahar requires Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers");
    }
    const storage = await UserStorageLock.acquire();
    const armJit = new ArmJitHost();
    try {
      const core = await factory({
        azaharJitHost: armJit,
        azaharPicaJitHost: new PicaJitHost(),
        azaharGraphicsHost: graphics,
        print: output.log,
        printErr: output.log,
        azaharVideo: (pointer, width, height, pitch) => {
          if (pointer > 0 && pointer !== 0xffffffff) {
            output.video(core.HEAPU8.subarray(pointer, pointer + pitch * height), width, height, pitch);
          }
        },
        azaharAudio: (pointer, frames, sampleRate) => output.audio(core.HEAP16.subarray(pointer >>> 1,
          (pointer >>> 1) + frames * 2), sampleRate),
      });
      if (core._azahar_web_abi() !== 9) throw new Error("Unsupported Azahar browser ABI");
      if (!core._azahar_mount_storage()) throw new Error("Azahar could not mount OPFS user storage");
      if (!core._azahar_initialize()) throw new Error("Azahar initialization failed");
      return new BrowserSession(core, storage, armJit, graphics);
    } catch (error) { storage.close(); throw error; }
  }

  async load(file: File): Promise<string> {
    this.checkOpen();
    if (this.#loaded) throw new Error("Close the current session before loading another game");
    if (!file.size || !Number.isSafeInteger(file.size) || /[/\\\0]/.test(file.name)) throw new Error("Invalid game file");
    const path = this.core.stringToNewUTF8(`/rom/${file.name}`);
    this.#gamePath = path;
    try {
      this.core.azaharGameFile = file;
      if (!this.core._azahar_mount_game_file(path, BigInt(file.size))) throw new Error("Azahar could not mount this game");
      if (!this.core._azahar_load_game(path)) throw new Error("Azahar could not load this game");
      this.#loaded = true;
      let game = this.core.UTF8ToString(this.core._azahar_program_id());
      if (game === "0000000000000000") {
        // Homebrew loaders may have no title ID; use the file's content identity.
        const identity = this.core._azahar_content_id(path);
        if (!identity) throw new Error("Azahar could not read this game's content identity");
        game = this.core.UTF8ToString(identity);
      }
      this.#states = await OpfsSaveStates.open(game);
      return game;
    } catch (error) {
      // A partially loaded kernel must not receive another load request.
      this.close();
      throw error;
    }
  }

  runFrame(): undefined {
    this.checkLoaded();
    if (!this.core._azahar_run_frame()) throw new Error("Azahar stopped running");
    return undefined;
  }

  performance(): PerformanceStats {
    this.checkLoaded();
    const pointer = this.core._azahar_performance_stats();
    if (!pointer || pointer % 8 || pointer + 72 > this.core.HEAPU8.byteLength) {
      throw new Error("Invalid native performance snapshot");
    }
    const values = new Float64Array(this.core.HEAPU8.buffer, pointer, 9);
    if (!values.every(Number.isFinite)) throw new Error("Invalid native performance counters");
    return {
      systemFps: values[0]!, gameFps: values[1]!, emulationSpeed: values[2]!,
      vblankMs: values[3]! * 1000, hleSvcMs: values[4]! * 1000,
      hleIpcMs: values[5]! * 1000, gpuCommandMs: values[6]! * 1000,
      swapMs: values[7]! * 1000, otherMs: values[8]! * 1000,
      armJit: { ...this.armJit.takeStatistics(), ...this.executionStatistics() },
      graphics: this.graphics.takeStatistics(),
    };
  }

  private executionStatistics(): { execution?: ArmExecutionStatistics } {
    if (!this.core._azahar_arm_jit_statistics_enabled()) return {};
    const counts = {
      nativeDispatches: this.core._azahar_arm_jit_native_dispatches(),
      completedBlocks: this.core._azahar_arm_jit_completed_blocks(),
      budgetReuses: this.core._azahar_arm_jit_budget_reuses(),
      fastDispatchHits: this.core._azahar_arm_jit_fast_dispatch_hits(),
    };
    const delta = (current: bigint, previous: bigint): number => {
      const value = Number(current - previous);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid ARM execution counter");
      return value;
    };
    const previous = this.#lastExecutionCounts;
    const nativeDispatches = delta(counts.nativeDispatches, previous.nativeDispatches);
    const completedBlocks = delta(counts.completedBlocks, previous.completedBlocks);
    const execution = {
      nativeDispatches, completedBlocks,
      linkedBlocks: Math.max(0, completedBlocks - nativeDispatches),
      budgetReuses: delta(counts.budgetReuses, previous.budgetReuses),
      fastDispatchHits: delta(counts.fastDispatchHits, previous.fastDispatchHits),
    };
    this.#lastExecutionCounts = counts;
    return { execution };
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
    try {
      this.core._azahar_shutdown();
      if (this.#gamePath) this.core._azahar_unmount_game_file(this.#gamePath);
    } finally {
      if (this.#gamePath) this.core._free(this.#gamePath);
      this.#gamePath = 0;
      this.core.azaharGameFile = undefined;
      this.storage.close();
    }
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
