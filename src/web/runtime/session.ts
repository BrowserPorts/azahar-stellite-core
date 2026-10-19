// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../arm/jit-host";
import type { ArmExecutionStatistics, ArmJitStatistics } from "../arm/jit-host";
import { PicaJitHost } from "../pica/jit-host";
import type { GraphicsClient, GraphicsStatistics } from "../gpu/client";
import type { AzaharModule, AzaharModuleFactory } from "./module";
import { OpfsSaveStates } from "./save-states";
import { MicrophoneConsumer } from "./microphone-ring";
import { UserStorageLock } from "./storage-lock";
import { wasmAssetOptions } from "../assets";
import type { RuntimeAssets } from "../assets";
import { checkInputState } from "./input-state";
import type { InputState } from "./input-state";
export type { InputState } from "./input-state";

export interface SessionOutput {
  video(bytes: Uint8Array<SharedArrayBuffer>, width: number, height: number, pitch: number): unknown;
  audio(samples: Int16Array<SharedArrayBuffer>, sampleRate: number): unknown;
  log(line: string): unknown;
  installProgress(written: number, total: number): unknown;
}

export interface InstalledTitle {
  id: string;
  title: string;
  version: number;
  executable: boolean;
  media: "nand" | "sdmc";
}

export interface MotionState {
  /** Device axes: right, up, out; acceleration including gravity in m/s². */
  acceleration: { x: number; y: number; z: number };
  /** DeviceMotionEvent rates in degrees/sec: alpha about Z, beta about X, gamma about Y. */
  rotationRate: { alpha: number; beta: number; gamma: number };
  /** Counter-clockwise screen rotation from natural orientation, in degrees. */
  screenAngle: 0 | 90 | 180 | 270;
}

/** Options and legal values supplied by Azahar's native frontend definitions. */
export interface CoreOption {
  key: string;
  value: string;
  defaultValue: string;
  label: string;
  description: string;
  category: string;
  values: { value: string; label: string }[];
}

/** Native frame averages and browser interval totals, including frame pacing time. */
export interface PerformanceStats {
  /** Successful native frame calls since the previous snapshot. */
  completedFrames: number;
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
  /** Cumulative opcode specialization totals across this session's Wasm threads. */
  dspJit: { installedEntries: number; optimizedEntries: number };
  /** Totals since the previous snapshot, rather than per-frame averages. */
  graphics: GraphicsStatistics;
}

/** All native entry points are called between frames on the emulation worker. */
export class BrowserSession {
  #states: OpfsSaveStates | undefined;
  #completedFrames = 0;
  #loaded = false;
  #closed = false;
  #gamePath = 0;
  #lastExecutionCounts = {
    nativeDispatches: 0n, completedBlocks: 0n,
    budgetReuses: 0n, fastDispatchHits: 0n,
  };

  private constructor(readonly core: AzaharModule, private readonly storage: UserStorageLock,
    private readonly armJit: ArmJitHost, private readonly graphics: GraphicsClient,
    readonly microphone: MicrophoneConsumer) {}

  static async create(factory: AzaharModuleFactory, output: SessionOutput,
    graphics: GraphicsClient, assets?: RuntimeAssets): Promise<BrowserSession> {
    if (!globalThis.crossOriginIsolated) {
      throw new Error("Azahar requires Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers");
    }
    const storage = await UserStorageLock.acquire();
    const armJit = new ArmJitHost();
    const microphone = new MicrophoneConsumer();
    try {
      const core = await factory({
        ...wasmAssetOptions(assets, "azahar-core.mjs"),
        azaharLazyDsp: true,
        azaharInstallProgress: output.installProgress,
        azaharJitHost: armJit,
        azaharMicrophoneActive: active => microphone.active(active),
        azaharMicrophoneRead: (pointer, count) => microphone.read(core.HEAP16.subarray(
          pointer >>> 1, (pointer >>> 1) + count)),
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
      if (core._azahar_web_abi() !== 21) throw new Error("Unsupported Azahar browser ABI");
      if (!core._azahar_mount_storage()) throw new Error("Azahar could not mount OPFS user storage");
      if (!await core._azahar_initialize()) throw new Error("Azahar initialization failed");
      return new BrowserSession(core, storage, armJit, graphics, microphone);
    } catch (error) { storage.close(); throw error; }
  }

  importUserFile(file: File, path: string): number {
    this.checkOpen();
    if (this.#loaded) throw new Error("Import user files before loading a game");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || /[\\\0]/.test(path) ||
      new TextEncoder().encode(path).length >= 4096 ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid user file path or size");
    }
    const pointer = this.core.stringToNewUTF8(path);
    if (!pointer) throw new Error("Azahar could not allocate the user file path");
    try {
      this.core.azaharImportFile = file;
      if (!this.core._azahar_import_user_file(pointer, BigInt(file.size))) {
        throw new Error(`Azahar could not import ${path} into OPFS`);
      }
      return file.size;
    } finally {
      this.core.azaharImportFile = undefined;
      this.core._free(pointer);
    }
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
      return await this.loadPath(path);
    } catch (error) {
      // A partially loaded kernel must not receive another load request.
      await this.close();
      throw error;
    }
  }

  async install(file: File): Promise<undefined> {
    this.checkOpen();
    if (this.#loaded) throw new Error("Install CIA packages before loading a game");
    if (!file.size || !Number.isSafeInteger(file.size) || /[/\\\0]/.test(file.name)) {
      throw new Error("Invalid CIA file");
    }
    const path = this.core.stringToNewUTF8(`/rom/${file.name}`);
    if (!path) throw new Error("Azahar could not allocate the CIA path");
    let mounted = false;
    try {
      this.core.azaharGameFile = file;
      if (!this.core._azahar_mount_game_file(path, BigInt(file.size))) throw new Error("Azahar could not mount this CIA");
      mounted = true;
      const status = await this.core._azahar_install_cia(path);
      if (status !== 0) {
        const messages = ["", "Could not open the CIA", "CIA file not found", "CIA installation aborted",
          "Invalid CIA package", "The CIA contains encrypted content"];
        throw new Error(messages[status] ?? `CIA installation failed (${status})`);
      }
      return undefined;
    } finally {
      if (mounted) this.core._azahar_unmount_game_file(path);
      this.core.azaharGameFile = undefined;
      this.core._free(path);
    }
  }

  installedTitles(): InstalledTitle[] {
    this.checkOpen();
    const pointer = this.core._azahar_installed_titles();
    if (!pointer) throw new Error("Installed titles are unavailable");
    return JSON.parse(this.core.UTF8ToString(pointer)) as InstalledTitle[];
  }

  async loadInstalled(id: string): Promise<string> {
    this.checkOpen();
    if (this.#loaded) throw new Error("Close the current session before loading another game");
    if (typeof id !== "string" || !/^[0-9a-fA-F]{16}$/.test(id)) throw new Error("Invalid installed title ID");
    const path = this.core._azahar_installed_title_path(BigInt(`0x${id}`));
    if (!path) throw new Error("The installed title is unavailable");
    try {
      return await this.loadPath(path);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async loadPath(path: number): Promise<string> {
    if (!await this.core._azahar_load_game(path)) throw new Error("Azahar could not load this game");
    this.#loaded = true;
    let game = this.core.UTF8ToString(this.core._azahar_program_id());
    if (game === "0000000000000000") {
      const identity = this.core._azahar_content_id(path);
      if (!identity) throw new Error("Azahar could not read this game's content identity");
      game = this.core.UTF8ToString(identity);
    }
    this.#states = await OpfsSaveStates.open(game);
    return game;
  }

  async runFrame(): Promise<undefined> {
    this.checkLoaded();
    if (!await this.core._azahar_run_frame()) throw new Error("Azahar stopped running");
    this.#completedFrames++;
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
    const completedFrames = this.#completedFrames;
    this.#completedFrames = 0;
    return {
      completedFrames,
      systemFps: values[0]!, gameFps: values[1]!, emulationSpeed: values[2]!,
      vblankMs: values[3]! * 1000, hleSvcMs: values[4]! * 1000,
      hleIpcMs: values[5]! * 1000, gpuCommandMs: values[6]! * 1000,
      swapMs: values[7]! * 1000, otherMs: values[8]! * 1000,
      armJit: { ...this.armJit.takeStatistics(), ...this.executionStatistics() },
      dspJit: { installedEntries: this.core._azahar_dsp_jit_entries(),
        optimizedEntries: this.core._azahar_dsp_jit_optimized_entries() },
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
    checkInputState(value);
    this.core._azahar_set_input(value.buttons, value.circleX, value.circleY,
      value.cstickX, value.cstickY, value.touchX, value.touchY, Number(value.touchPressed));
    return undefined;
  }

  options(): CoreOption[] {
    this.checkOpen();
    const pointer = this.core._azahar_core_options();
    if (!pointer) throw new Error("Azahar core options are unavailable");
    return JSON.parse(this.core.UTF8ToString(pointer)) as CoreOption[];
  }

  motion(value: MotionState | null): undefined {
    this.checkOpen();
    if (value === null) { this.core._azahar_reset_motion(); return undefined; }
    if (!value?.acceleration || !value.rotationRate || ![0, 90, 180, 270].includes(value.screenAngle)) {
      throw new Error("Invalid motion state");
    }
    const a = value.acceleration;
    const r = value.rotationRate;
    if (![a.x, a.y, a.z, r.alpha, r.beta, r.gamma].every(component =>
      typeof component === "number" && Number.isFinite(component) && Number.isFinite(Math.fround(component)))) {
      throw new Error("Invalid motion sample");
    }
    if (!this.core._azahar_set_motion(a.x, a.y, a.z, r.beta, r.gamma, r.alpha, value.screenAngle / 90)) {
      throw new Error("Azahar could not update motion input");
    }
    return undefined;
  }

  setOption(key: string, value: string): undefined {
    this.checkOpen();
    if (typeof key !== "string" || typeof value !== "string" ||
      !key || !value || key.length > 256 || value.length > 256 || /\0/.test(key + value)) {
      throw new Error("Invalid core option key or value");
    }
    const keyPointer = this.core.stringToNewUTF8(key);
    if (!keyPointer) throw new Error("Azahar could not allocate the option key");
    let valuePointer = 0;
    try {
      valuePointer = this.core.stringToNewUTF8(value);
      if (!valuePointer) throw new Error("Azahar could not allocate the option value");
      if (!this.core._azahar_set_core_option(keyPointer, valuePointer)) {
        throw new Error(`Unsupported value for core option ${key}`);
      }
    } finally {
      if (valuePointer) this.core._free(valuePointer);
      this.core._free(keyPointer);
    }
    return undefined;
  }

  save(slot: number): Promise<number> {
    this.checkLoaded();
    if (!this.#states) throw new Error("Save-state storage is unavailable");
    return this.#states.save(slot, this.core);
  }

  async reset(): Promise<undefined> {
    this.checkLoaded();
    try {
      if (!await this.core._azahar_reset_game()) throw new Error("Azahar could not reset this game");
      // Reset native and browser counters together after rebuilding the game state.
      this.performance();
    } catch (error) {
      await this.close();
      throw error;
    }
    return undefined;
  }

  restore(slot: number): Promise<number> {
    this.checkLoaded();
    if (!this.#states) throw new Error("Save-state storage is unavailable");
    return this.#states.load(slot, this.core);
  }

  async close(): Promise<undefined> {
    if (this.#closed) return undefined;
    this.#closed = true;
    try {
      this.microphone.close();
      await this.core._azahar_shutdown();
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
