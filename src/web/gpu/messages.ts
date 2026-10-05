// SPDX-License-Identifier: GPL-2.0-or-later

import type { TextureRegion } from "./textures";
import type { TextureRect } from "./blits";
import type { NativeSampler } from "./samplers";
import type { ScreenFrame } from "./screens";

export interface GraphicsAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export type GraphicsCommand =
  { type: "initialize"; fence: SharedArrayBuffer } |
  { type: "surface"; id: number; canvas: OffscreenCanvas } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "screens"; frame: ScreenFrame } |
  { type: "finish"; sequence: number } |
  { type: "texture-create"; handle: number; width: number; height: number; levels: number; layers: number; format: number } |
  { type: "texture-destroy"; handle: number } |
  { type: "texture-copy"; source: number; dest: number; src: TextureRegion; dst: TextureRegion } |
  { type: "texture-blit"; source: number; dest: number; src: TextureRect; dst: TextureRect } |
  { type: "texture-mipmaps"; handle: number } |
  { type: "sampler-create"; handle: number; params: NativeSampler } |
  { type: "sampler-destroy"; handle: number } |
  { type: "vertex-program-create"; handle: number; source: string } |
  { type: "vertex-program-destroy"; handle: number } |
  { type: "draw"; bytes: Uint8Array<ArrayBuffer>; program: number; picaUniforms?: Uint8Array<ArrayBuffer> } |
  { type: "lookup-table"; table: number; offset: number; bytes: Uint8Array<ArrayBuffer> } |
  { type: "texture-clear"; handle: number; region: TextureRegion; value: readonly number[]; stencil: number } |
  { type: "texture-upload"; handle: number; region: TextureRegion; bytes: Uint8Array<ArrayBuffer> } |
  { type: "texture-download"; handle: number; region: TextureRegion;
    destination: Uint8Array<SharedArrayBuffer>; sequence: number } |
  { type: "close"; id: number };

export interface GraphicsRequest {
  commands: GraphicsCommand[];
}

export type GraphicsEvent =
  { type: "ready"; configurationSize: number; configurationSchema: bigint; adapter: GraphicsAdapterInfo } |
  { type: "presented" } |
  { type: "reply"; id: number } |
  { type: "error"; message: string; id?: number };

// Completion sequence, permanent failure flag, UTF-8 error length, and error bytes.
export const fenceErrorOffset = 12;
export const fenceByteLength = fenceErrorOffset + 2048;
