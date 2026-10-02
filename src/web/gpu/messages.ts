// SPDX-License-Identifier: GPL-2.0-or-later

import type { TextureRegion } from "./textures";

export type GraphicsRequest =
  { type: "initialize"; fence: SharedArrayBuffer } |
  { type: "surface"; id: number; canvas: OffscreenCanvas } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "finish"; sequence: number } |
  { type: "texture-create"; handle: number; width: number; height: number; levels: number; layers: number; format: number } |
  { type: "texture-destroy"; handle: number } |
  { type: "texture-clear"; handle: number; region: TextureRegion; value: readonly number[]; stencil: number } |
  { type: "texture-upload"; handle: number; region: TextureRegion; bytes: Uint8Array<ArrayBuffer> } |
  { type: "texture-download"; handle: number; region: TextureRegion;
    destination: Uint8Array<SharedArrayBuffer>; sequence: number } |
  { type: "close"; id: number };

export type GraphicsEvent =
  { type: "ready"; configurationSize: number; configurationSchema: bigint } |
  { type: "presented" } |
  { type: "reply"; id: number } |
  { type: "error"; message: string; id?: number };

// Completion sequence, permanent failure flag, UTF-8 error length, and error bytes.
export const fenceErrorOffset = 12;
export const fenceByteLength = fenceErrorOffset + 2048;
