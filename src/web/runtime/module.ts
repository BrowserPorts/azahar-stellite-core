// SPDX-License-Identifier: GPL-2.0-or-later

import type { ArmJitHost } from "../arm/jit-host";
import type { PicaJitHost } from "../pica/jit-host";
import type { DspJitHost } from "../dsp/jit-host";
import type { GraphicsClient } from "../gpu/client";
import type { WasmAssetOptions } from "../assets";

/** Exported by the azahar_browser Emscripten target. */
export interface AzaharModule {
  HEAPU8: Uint8Array<SharedArrayBuffer>;
  HEAPU32: Uint32Array<SharedArrayBuffer>;
  HEAP16: Int16Array<SharedArrayBuffer>;
  azaharGameFile: File | undefined;
  azaharImportFile: File | undefined;
  UTF8ToString(pointer: number): string;
  stringToNewUTF8(text: string): number;
  addFunction(callback: (...args: number[]) => unknown, signature: string): number;
  removeFunction(pointer: number): unknown;
  _azahar_web_abi(): number;
  _azahar_frame_rate(): number;
  _azahar_audio_sample_rate(): number;
  _azahar_arm_jit_statistics_enabled(): number;
  _azahar_arm_jit_native_dispatches(): bigint;
  _azahar_arm_jit_completed_blocks(): bigint;
  _azahar_arm_jit_budget_reuses(): bigint;
  _azahar_arm_jit_fast_dispatch_hits(): bigint;
  _azahar_dsp_jit_entries(): number;
  _azahar_dsp_jit_optimized_entries(): number;
  _azahar_mount_storage(): number;
  _azahar_mount_game_file(path: number, size: bigint): number;
  _azahar_unmount_game_file(path: number): number;
  _azahar_import_user_file(path: number, size: bigint): number;
  _azahar_content_id(path: number): number;
  _azahar_initialize(): Promise<number>;
  _azahar_core_options(): number;
  _azahar_set_core_option(key: number, value: number): number;
  _azahar_load_game(path: number): Promise<number>;
  _azahar_install_cia(path: number): Promise<number>;
  _azahar_last_installed_title(): number;
  _azahar_installed_titles(): number;
  _azahar_installed_title_path(title: bigint): number;
  _azahar_program_id(): number;
  _azahar_run_frame(): Promise<number>;
  _azahar_reset_game(): Promise<number>;
  _azahar_flush_saves(): Promise<number>;
  _azahar_performance_stats(): number;
  _azahar_set_input(mask: number, lx: number, ly: number, rx: number, ry: number,
    x: number, y: number, touch: number): unknown;
  _azahar_set_motion(ax: number, ay: number, az: number, rx: number, ry: number, rz: number,
    screenRotation: number): number;
  _azahar_reset_motion(): unknown;
  _azahar_shutdown(): Promise<unknown>;
  _malloc(bytes: number): number;
  _free(pointer: number): unknown;
  _retro_init(): unknown;
  _retro_deinit(): unknown;
  _retro_set_environment(pointer: number): unknown;
  _retro_set_video_refresh(pointer: number): unknown;
  _retro_set_audio_sample_batch(pointer: number): unknown;
  _retro_set_input_poll(pointer: number): unknown;
  _retro_set_input_state(pointer: number): unknown;
  _retro_load_game(pointer: number): number;
  _retro_unload_game(): unknown;
  _retro_run(): unknown;
  _retro_serialize_size(): Promise<number>;
  _retro_serialize(pointer: number, length: number): Promise<number>;
  _retro_unserialize(pointer: number, length: number): Promise<number>;
}

export interface AzaharModuleOptions extends WasmAssetOptions {
  azaharDspJitHost?: DspJitHost;
  azaharLazyDsp?: boolean;
  azaharJitHost: ArmJitHost;
  azaharPicaJitHost: PicaJitHost;
  azaharGraphicsHost: GraphicsClient;
  print: (line: string) => unknown;
  printErr: (line: string) => unknown;
  azaharVideo: (pointer: number, width: number, height: number, pitch: number) => unknown;
  azaharMicrophoneRead?: (pointer: number, count: number) => number;
  azaharMicrophoneActive?: (active: boolean) => unknown;
  azaharAudio: (pointer: number, frames: number, sampleRate: number) => unknown;
  azaharInstallProgress?: (written: number, total: number) => unknown;
}

export type AzaharModuleFactory = (options: AzaharModuleOptions) => Promise<AzaharModule>;
