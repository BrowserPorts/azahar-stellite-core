// SPDX-License-Identifier: GPL-2.0-or-later

import type { AzaharModuleFactory } from "./module";
import type { SessionEvent, SessionInitialize, SessionRequest, SessionResult } from "./messages";
import { resolveRuntimeAssets } from "../assets";
import type { RuntimeAssets } from "../assets";
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
let frameInterval = 0;
let frameTasks: AbortController | undefined;
let session: BrowserSession | undefined;
let graphics: GraphicsClient | undefined;
let audio: AudioProducer | undefined;
let commands: Promise<unknown> = Promise.resolve();
let initialized = false;

function pause(): undefined {
  running = false;
  frameTasks?.abort();
  frameTasks = undefined;
  audio?.clear();
  session?.microphone.running(false);
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
  const signal = frameTasks?.signal;
  if (!running || !session || !signal) return undefined;
  // A suspended native frame must finish before another command enters the core.
  commands = commands.then(async () => {
    if (!running || !session || signal.aborted) return undefined;
    try {
      await session.runFrame();
      if (signal.aborted) return undefined;
      const now = performance.now();
      // Drop accumulated wall-clock debt when background throttling resumes.
      nextFrame = Math.max(nextFrame + frameInterval, now - frameInterval);
      scheduleFrame(Math.max(0, nextFrame - now));
    } catch (error) { pause(); report(error); }
    return undefined;
  }).catch(report);
  return undefined;
}

async function start(): Promise<undefined> {
  if (running) return undefined;
  if (!session) throw new Error("Azahar is unavailable");
  audio?.clear();
  // Let the command handler report a failed first frame to its caller.
  session.microphone.running(true);
  try { await session.runFrame(); }
  catch (error) { session.microphone.running(false); throw error; }
  frameTasks = new AbortController();
  running = true;
  nextFrame = performance.now() + frameInterval;
  scheduleFrame(frameInterval);
  return undefined;
}

async function initialize(assets: RuntimeAssets): Promise<BrowserSession> {
  if (typeof worker.scheduler?.postTask !== "function") {
    throw new Error("Azahar requires browser task scheduling");
  }
  const { default: factory } = await import(assets["azahar-core.mjs"]) as { default: AzaharModuleFactory };
  graphics = await GraphicsClient.create((error) => { pause(); report(error); }, assets);
  try {
    return await BrowserSession.create(factory, {
      log: (line) => post({ type: "log", line }),
      installProgress: (written, total) => post({ type: "install-progress", written, total }),
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
    }, graphics, assets);
  } catch (error) {
    await graphics.close().catch(() => undefined);
    throw error;
  }
}

worker.onmessage = (event: MessageEvent<SessionRequest | SessionInitialize>): undefined => {
  const request = event.data;
  if (request.type === "initialize") {
    if (initialized) { report(new Error("Azahar is already initialized")); return undefined; }
    initialized = true;
    commands = Promise.resolve().then(() => initialize(resolveRuntimeAssets(import.meta.url, request.assets)))
      .then(value => {
        session = value;
        frameInterval = 1000 / value.core._azahar_frame_rate();
        post({ type: "ready", sampleRate: value.core._azahar_audio_sample_rate() });
      }).catch(report);
    return undefined;
  }
  commands = commands.then(async () => {
    if (!Number.isSafeInteger(request.id) || request.id < 0) throw new Error("Invalid session request ID");
    try {
      if (!session) throw new Error("Azahar is unavailable");
      let result: SessionResult;
      switch (request.type) {
        case "import-user-file": result = session.importUserFile(request.file, request.path); break;
        case "load": pause(); result = await session.load(request.file); break;
        case "install": result = await session.install(request.file); break;
        case "load-installed": pause(); result = await session.loadInstalled(request.title); break;
        case "installed-titles": result = session.installedTitles(); break;
        case "surface": {
          pause();
          if (!graphics) throw new Error("WebGPU is unavailable");
          await graphics.surface(request.canvas);
          break;
        }
        case "microphone-input": session.microphone.attach(request.transport); break;
        case "audio-output": {
          if (audio) throw new Error("Browser audio is already connected");
          if (request.transport.sampleRate !== session.core._azahar_audio_sample_rate()) {
            throw new Error("Browser audio does not match the native sample rate");
          }
          audio = new AudioProducer(request.transport);
          audio.clear();
          break;
        }
        case "start": await start(); break;
        case "pause": pause(); break;
        case "flush-saves": await session.flushSaves(); break;
        case "reset": {
          const resume = running;
          pause();
          await session.reset();
          if (resume) await start();
          break;
        }
        case "advance-frame":
          if (running) throw new Error("Pause Azahar before advancing a frame");
          if (!graphics) throw new Error("WebGPU is unavailable");
          // Clear prior presentations so the manually stepped frame cannot be dropped.
          await graphics.waitForIdle();
          session.microphone.running(true);
          try {
            await session.runFrame();
            await graphics.waitForIdle();
          }
          finally { session.microphone.running(false); }
          break;
        case "input": session.input(request.state); break;
        case "motion": session.motion(request.state); break;
        case "options": result = session.options(); break;
        case "set-option": session.setOption(request.key, request.value); break;
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
              session.microphone.running(true);
              frameTasks = new AbortController();
              running = true; nextFrame = performance.now(); frame();
            }
          }
          break;
        }
        case "close":
          pause(); audio?.close(); audio = undefined;
          await session.close(); await graphics?.close(); graphics = undefined; break;
        default: throw new Error("Unknown Azahar session request");
      }
      post({ type: "reply", id: request.id, result });
    } catch (error) { report(error, request.id); }
  }).catch(report);
  return undefined;
};
