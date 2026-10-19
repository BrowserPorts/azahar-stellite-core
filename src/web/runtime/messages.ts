// SPDX-License-Identifier: GPL-2.0-or-later

import type { CoreOption, InputState, InstalledTitle, MotionState, PerformanceStats } from "./session";
import type { MicrophoneTransport } from "./microphone-ring";
import type { AudioTransport } from "./audio-ring";
import type { RuntimeAssets } from "../assets";

export interface SessionInitialize {
  type: "initialize";
  assets: RuntimeAssets;
}

export type SessionResult = string | number | PerformanceStats | CoreOption[] | InstalledTitle[] | undefined;

export type SessionRequest = { id: number } & (
  { type: "load"; file: File } |
  { type: "install"; file: File } |
  { type: "load-installed"; title: string } |
  { type: "import-user-file"; file: File; path: string } |
  { type: "surface"; canvas: OffscreenCanvas } |
  { type: "microphone-input"; transport: MicrophoneTransport } |
  { type: "audio-output"; transport: AudioTransport } |
  { type: "start" | "pause" | "advance-frame" | "reset" | "flush-saves" | "close" | "performance" | "options" | "installed-titles" } |
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
  { type: "install-progress"; written: number; total: number } |
  { type: "video"; bytes: Uint8Array<ArrayBuffer>; width: number; height: number; pitch: number } |
  { type: "audio"; samples: Int16Array<ArrayBuffer>; sampleRate: number };
