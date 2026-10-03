// SPDX-License-Identifier: GPL-2.0-or-later

import type { AzaharModuleFactory } from "./module";
import type { SessionEvent, SessionRequest, SessionResult } from "./messages";
import { BrowserSession } from "./session";
import { GraphicsClient } from "../gpu/client";

const worker = self as unknown as DedicatedWorkerGlobalScope;
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
let timer: ReturnType<typeof setTimeout> | undefined;
let session: BrowserSession | undefined;
let graphics: GraphicsClient | undefined;
let commands: Promise<unknown> = Promise.resolve();

function pause(): undefined {
  running = false;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  return undefined;
}

function frame(): undefined {
  timer = undefined;
  if (!running || !session) return undefined;
  try {
    session.runFrame();
    const now = performance.now();
    // Drop accumulated wall-clock debt when background throttling resumes.
    nextFrame = Math.max(nextFrame + 1000 / 60, now - 1000 / 60);
    timer = setTimeout(frame, Math.max(0, nextFrame - now));
  } catch (error) { pause(); report(error); }
  return undefined;
}

function start(): undefined {
  if (running) return undefined;
  if (!session) throw new Error("Azahar is unavailable");
  // Let the command handler report a failed first frame to its caller.
  session.runFrame();
  running = true;
  nextFrame = performance.now() + 1000 / 60;
  timer = setTimeout(frame, 1000 / 60);
  return undefined;
}

async function initialize(): Promise<BrowserSession> {
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
      audio: (view) => {
        const samples = view.slice();
        return post({ type: "audio", samples }, [samples.buffer]);
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
        case "load": pause(); result = await session.load(request.file); break;
        case "surface": {
          pause();
          if (!graphics) throw new Error("WebGPU is unavailable");
          await graphics.surface(request.canvas);
          break;
        }
        case "start": start(); break;
        case "pause": pause(); break;
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
              running = true; nextFrame = performance.now(); frame();
            }
          }
          break;
        }
        case "close": pause(); session.close(); await graphics?.close(); graphics = undefined; break;
        default: throw new Error("Unknown Azahar session request");
      }
      post({ type: "reply", id: request.id, result });
    } catch (error) { report(error, request.id); }
  }).catch(report);
  return undefined;
};

commands = initialize().then((value) => {
  session = value;
  post({ type: "ready" });
}).catch(report);
