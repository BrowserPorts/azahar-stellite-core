// SPDX-License-Identifier: GPL-2.0-or-later

import { UserStorageLock } from "../runtime/storage-lock";
import { BrowserAudioOutput } from "../runtime/audio-output";
import { GameImporter } from "./game-import";

const gameImporter = new GameImporter();

let storage: UserStorageLock | undefined;
let audio: BrowserAudioOutput | undefined;
let audioPending: Promise<BrowserAudioOutput> | undefined;
let audioAbort: AbortController | undefined;
let audioSampleRate = 0;
let audioRunning = false;
let audioWorker: Worker | undefined;
let audioReceiver: ((event: MessageEvent) => undefined) | undefined;
let audioConnection = 0;

const reportAudioError = (error: unknown): undefined => {
  console.error("Azahar audio:", error);
  return undefined;
};

function sendAudioTransport(output: BrowserAudioOutput, worker: Worker, connection: number): undefined {
  if (audioWorker !== worker || audioConnection !== connection) return undefined;
  worker.postMessage({ azaharQtAudioTransport: output.transport, azaharQtAudioConnection: connection });
  if (audioRunning) worker.postMessage({ azaharQtAudioResume: connection });
  return undefined;
}

function prepareAudio(): undefined {
  if (audioPending || !audioAbort) return undefined;
  const signal = audioAbort.signal;
  const pending = BrowserAudioOutput.create(audioSampleRate, reportAudioError, signal);
  audioPending = pending;
  pending.then(async output => {
    if (signal.aborted) return output.close();
    audio = output;
    // Resume playback only after the emulation worker has discarded its old queue.
    await output.suspend();
    if (audioWorker) sendAudioTransport(output, audioWorker, audioConnection);
    return undefined;
  }).catch(error => {
    if (audioPending === pending) audioPending = undefined;
    if (!signal.aborted) reportAudioError(error);
  });
  return undefined;
}

export async function initializeFrontend(sampleRate: number): Promise<undefined> {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("Azahar requires cross-origin isolation");
  }
  if (storage) throw new Error("Qt frontend storage is already open");
  storage = await UserStorageLock.acquire();
  audioSampleRate = sampleRate;
  audioAbort = new AbortController();
  document.addEventListener("pointerdown", prepareAudio, { capture: true });
  document.addEventListener("keydown", prepareAudio, { capture: true });
  return undefined;
}

export function connectAudio(worker: Worker): undefined {
  if (audioWorker && audioReceiver) audioWorker.removeEventListener("message", audioReceiver);
  audioWorker = worker;
  const connection = ++audioConnection;
  audioReceiver = event => {
    if (event.data?.azaharQtAudioReady === connection && audioRunning && audioWorker === worker) {
      audio?.resume().catch(reportAudioError);
    }
    return undefined;
  };
  worker.addEventListener("message", audioReceiver);
  if (audio) {
    const output = audio;
    output.suspend().then(() => sendAudioTransport(output, worker, connection)).catch(reportAudioError);
  }
  return undefined;
}

export function setAudioRunning(running: boolean): undefined {
  audioRunning = running;
  if (running) audioWorker?.postMessage({ azaharQtAudioResume: audioConnection });
  else audio?.suspend().catch(reportAudioError);
  return undefined;
}

export function disconnectAudio(worker: Worker): undefined {
  if (audioWorker !== worker) return undefined;
  setAudioRunning(false);
  if (audioReceiver) worker.removeEventListener("message", audioReceiver);
  audioWorker = undefined;
  audioReceiver = undefined;
  ++audioConnection;
  return undefined;
}

export const beginGameImport = (accept: string, multiple: boolean): boolean => gameImporter.begin(accept, multiple);
export const gameImportStatus = (): ReturnType<GameImporter["status"]> => gameImporter.status();
export const cancelGameImport = (): undefined => gameImporter.cancel();
export const finishGameImport = (): undefined => gameImporter.finish();

export function shutdownFrontend(): undefined {
  gameImporter.cancel();
  document.removeEventListener("pointerdown", prepareAudio, { capture: true });
  document.removeEventListener("keydown", prepareAudio, { capture: true });
  if (audioWorker) disconnectAudio(audioWorker);
  audioAbort?.abort();
  audioAbort = undefined;
  audio?.close().catch(reportAudioError);
  audio = undefined;
  audioPending = undefined;
  storage?.close();
  storage = undefined;
  return undefined;
}
