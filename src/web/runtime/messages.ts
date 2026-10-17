// SPDX-License-Identifier: GPL-2.0-or-later

import type { CoreOption, InputState, MotionState, PerformanceStats } from "./session";
import type { MicrophoneTransport } from "./microphone-ring";
import type { AudioTransport } from "./audio-ring";

export type SessionResult = string | number | PerformanceStats | CoreOption[] | undefined;

export type SessionRequest = { id: number } & (
  { type: "load"; file: File } |
  { type: "import-user-file"; file: File; path: string } |
  { type: "surface"; canvas: OffscreenCanvas } |
  { type: "microphone-input"; transport: MicrophoneTransport } |
  { type: "audio-output"; transport: AudioTransport } |
  { type: "start" | "pause" | "advance-frame" | "reset" | "close" | "performance" | "options" } |
  { type: "set-option"; key: string; value: string } |
  { type: "save" | "restore"; slot: number } |
  { type: "motion"; state: MotionState | null } |
  { type: "input"; state: InputState }
);

export type SessionEvent =
  { type: "ready"; sampleRate: number } |
  { type: "reply"; id: number; result: SessionResult } |
  { type: "error"; id?: number; message: string } |
  { type: "log"; line: string } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "audio"; samples: Int16Array<ArrayBuffer>; sampleRate: number };
