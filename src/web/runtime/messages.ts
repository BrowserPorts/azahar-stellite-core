// SPDX-License-Identifier: GPL-2.0-or-later

import type { InputState } from "./session";

export type SessionRequest = { id: number } & (
  { type: "load"; file: File } |
  { type: "start" | "pause" | "close" } |
  { type: "save" | "restore"; slot: number } |
  { type: "input"; state: InputState }
);

export type SessionEvent =
  { type: "ready" } |
  { type: "reply"; id: number; result: string | number | undefined } |
  { type: "error"; id?: number; message: string } |
  { type: "log"; line: string } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "audio"; samples: Int16Array<ArrayBuffer> };
