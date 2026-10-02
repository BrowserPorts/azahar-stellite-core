// SPDX-License-Identifier: GPL-2.0-or-later

import type { ArmJitHost } from "../arm/jit-host";
import type { PicaJitHost } from "../pica/jit-host";
import type { GraphicsClient } from "../gpu/client";

export interface CoreFileSystem {
  mkdirTree(path: string): unknown;
  writeFile(path: string, bytes: Uint8Array): unknown;
  unlink(path: string): unknown;
  mount(filesystem: unknown, options: { files: File[] }, path: string): unknown;
  unmount(path: string): unknown;
}

/** Exported by the azahar_browser Emscripten target. */
export interface AzaharModule {
  HEAPU8: Uint8Array<SharedArrayBuffer>;
  HEAPU32: Uint32Array<SharedArrayBuffer>;
  HEAP16: Int16Array<SharedArrayBuffer>;
  FS: CoreFileSystem;
  WORKERFS: unknown;
  UTF8ToString(pointer: number): string;
  stringToNewUTF8(text: string): number;
  addFunction(callback: (...args: number[]) => unknown, signature: string): number;
  removeFunction(pointer: number): unknown;
  _azahar_web_abi(): number;
  _azahar_initialize(): number;
  _azahar_load_game(path: number): number;
  _azahar_program_id(): number;
  _azahar_run_frame(): number;
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
  azaharJitHost: ArmJitHost;
  azaharPicaJitHost: PicaJitHost;
  azaharGraphicsHost: GraphicsClient;
  print: (line: string) => unknown;
  printErr: (line: string) => unknown;
  azaharVideo: (pointer: number, width: number, height: number, pitch: number) => unknown;
  azaharAudio: (pointer: number, frames: number) => unknown;
}

export type AzaharModuleFactory = (options: AzaharModuleOptions) => Promise<AzaharModule>;
