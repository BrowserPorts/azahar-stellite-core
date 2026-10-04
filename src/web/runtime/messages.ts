// SPDX-License-Identifier: GPL-2.0-or-later

import type { InputState, PerformanceStats } from "./session";

export type SessionResult = string | number | PerformanceStats | undefined;

export type SessionRequest = { id: number } & (
  { type: "load"; file: File } |
  { type: "import-user-file"; file: File; path: string } |
  { type: "surface"; canvas: OffscreenCanvas } |
  { type: "start" | "pause" | "close" | "performance" } |
  { type: "save" | "restore"; slot: number } |
  { type: "input"; state: InputState }
);

export type SessionEvent =
  { type: "ready" } |
  { type: "reply"; id: number; result: SessionResult } |
  { type: "error"; id?: number; message: string } |
  { type: "log"; line: string } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "audio"; samples: Int16Array<ArrayBuffer>; sampleRate: number };
