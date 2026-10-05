// SPDX-License-Identifier: GPL-2.0-or-later

import type { AzaharModuleFactory } from "./module";
import type { SessionEvent, SessionRequest, SessionResult } from "./messages";
import { BrowserSession } from "./session";
import { GraphicsClient } from "../gpu/client";
import { AudioProducer } from "./audio-ring";

const worker = self as unknown as DedicatedWorkerGlobalScope & {
  scheduler: {
    postTask(callback: () => undefined,
      options: { delay: number; signal: AbortSignal }): Promise<undefined>;
  };
};
const post = (event: SessionEvent, transfer: Transferable[] = []): undefined => {
  worker.postMessage(event, transfer);
  return undefined;
};
const report = (error: unknown, id?: number): undefined => {
  post({ type: "error", ...(id === undefined ? {} : { id }),
    message: error instanceof Error ? error.message : String(error) });
  return undefined;
};

let running = false;
let nextFrame = 0;
let frameTasks: AbortController | undefined;
let session: BrowserSession | undefined;
let graphics: GraphicsClient | undefined;
let audio: AudioProducer | undefined;
let commands: Promise<unknown> = Promise.resolve();

function pause(): undefined {
  running = false;
  frameTasks?.abort();
  frameTasks = undefined;
  audio?.clear();
  return undefined;
}

function scheduleFrame(delay: number): undefined {
  const signal = frameTasks!.signal;
  // Posted tasks avoid the minimum delay imposed on nested frame timers.
  worker.scheduler.postTask(frame, { delay: Math.ceil(delay), signal }).catch((error) => {
    if (!signal.aborted) { pause(); report(error); }
    return undefined;
  });
  return undefined;
}

function frame(): undefined {
  if (!running || !session) return undefined;
  try {
    session.runFrame();
    const now = performance.now();
    // Drop accumulated wall-clock debt when background throttling resumes.
    nextFrame = Math.max(nextFrame + 1000 / 60, now - 1000 / 60);
    scheduleFrame(Math.max(0, nextFrame - now));
  } catch (error) { pause(); report(error); }
  return undefined;
}

function start(): undefined {
  if (running) return undefined;
  if (!session) throw new Error("Azahar is unavailable");
  audio?.clear();
  // Let the command handler report a failed first frame to its caller.
  session.runFrame();
  frameTasks = new AbortController();
  running = true;
  nextFrame = performance.now() + 1000 / 60;
  scheduleFrame(1000 / 60);
  return undefined;
}

async function initialize(): Promise<BrowserSession> {
  if (typeof worker.scheduler?.postTask !== "function") {
    throw new Error("Azahar requires browser task scheduling");
  }
  const url = new URL("./azahar-core.mjs", import.meta.url);
  const { default: factory } = await import(url.href) as { default: AzaharModuleFactory };
  graphics = await GraphicsClient.create((error) => { pause(); report(error); });
  try {
    return await BrowserSession.create(factory, {
      log: (line) => post({ type: "log", line }),
      video: (view, width, height, pitch) => {
        if (graphics?.present(view, width, height, pitch)) return undefined;
        const bytes = view.slice();
        return post({ type: "video", bytes, width, height, pitch }, [bytes.buffer]);
      },
      audio: (view, sampleRate) => {
        if (audio) return audio.write(view, sampleRate);
        const samples = view.slice();
        return post({ type: "audio", samples, sampleRate }, [samples.buffer]);
      },
    }, graphics);
  } catch (error) {
    await graphics.close().catch(() => undefined);
    throw error;
  }
}

worker.onmessage = (event: MessageEvent<SessionRequest>): undefined => {
  commands = commands.then(async () => {
    const request = event.data;
    if (!Number.isSafeInteger(request.id) || request.id < 0) throw new Error("Invalid session request ID");
    try {
      if (!session) throw new Error("Azahar is unavailable");
      let result: SessionResult;
      switch (request.type) {
        case "import-user-file": result = session.importUserFile(request.file, request.path); break;
        case "load": pause(); result = await session.load(request.file); break;
        case "surface": {
          pause();
          if (!graphics) throw new Error("WebGPU is unavailable");
          await graphics.surface(request.canvas);
          break;
        }
        case "audio-output": {
          if (audio) throw new Error("Browser audio is already connected");
          if (request.transport.sampleRate !== session.core._azahar_audio_sample_rate()) {
            throw new Error("Browser audio does not match the native sample rate");
          }
          audio = new AudioProducer(request.transport);
          audio.clear();
          break;
        }
        case "start": start(); break;
        case "pause": pause(); break;
        case "advance-frame":
          if (running) throw new Error("Pause Azahar before advancing a frame");
          session.runFrame();
          break;
        case "input": session.input(request.state); break;
        case "performance": result = session.performance(); break;
        case "save":
        case "restore": {
          const resume = running;
          let completed = false;
          pause();
          try {
            result = await (request.type === "save" ? session.save(request.slot) : session.restore(request.slot));
            completed = true;
          } finally {
            if (resume && (completed || request.type === "save")) {
              frameTasks = new AbortController();
              running = true; nextFrame = performance.now(); frame();
            }
          }
          break;
        }
        case "close":
          pause(); audio?.close(); audio = undefined;
          session.close(); await graphics?.close(); graphics = undefined; break;
        default: throw new Error("Unknown Azahar session request");
      }
      post({ type: "reply", id: request.id, result });
    } catch (error) { report(error, request.id); }
  }).catch(report);
  return undefined;
};

commands = initialize().then((value) => {
  session = value;
  post({ type: "ready", sampleRate: value.core._azahar_audio_sample_rate() });
}).catch(report);
