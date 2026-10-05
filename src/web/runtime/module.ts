// SPDX-License-Identifier: GPL-2.0-or-later

import type { ArmJitHost } from "../arm/jit-host";
import type { PicaJitHost } from "../pica/jit-host";
import type { DspJitHost } from "../dsp/jit-host";
import type { GraphicsClient } from "../gpu/client";

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
  _azahar_initialize(): number;
  _azahar_load_game(path: number): number;
  _azahar_program_id(): number;
  _azahar_run_frame(): number;
  _azahar_performance_stats(): number;
  _azahar_set_input(mask: number, lx: number, ly: number, rx: number, ry: number,
    x: number, y: number, touch: number): unknown;
  _azahar_shutdown(): unknown;
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
  _retro_serialize_size(): number;
  _retro_serialize(pointer: number, length: number): number;
  _retro_unserialize(pointer: number, length: number): number;
}

export interface AzaharModuleOptions {
  azaharDspJitHost?: DspJitHost;
  azaharJitHost: ArmJitHost;
  azaharPicaJitHost: PicaJitHost;
  azaharGraphicsHost: GraphicsClient;
  print: (line: string) => unknown;
  printErr: (line: string) => unknown;
  azaharVideo: (pointer: number, width: number, height: number, pitch: number) => unknown;
  azaharAudio: (pointer: number, frames: number, sampleRate: number) => unknown;
}

export type AzaharModuleFactory = (options: AzaharModuleOptions) => Promise<AzaharModule>;
