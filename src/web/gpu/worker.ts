// SPDX-License-Identifier: GPL-2.0-or-later

import type { GraphicsEvent, GraphicsRequest } from "./messages";
import { fenceByteLength, fenceErrorOffset } from "./messages";
import { PicaShaders } from "./pica-shaders";
import { WebGpuPresenter } from "./presenter";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let commands: Promise<unknown> = Promise.resolve();
let control: Int32Array<SharedArrayBuffer> | undefined;
let errorBytes: Uint8Array<SharedArrayBuffer> | undefined;
let device: GPUDevice | undefined;
let shaders: PicaShaders | undefined;
let presenter: WebGpuPresenter | undefined;
let failure: string | undefined;
let closed = false;

function post(event: GraphicsEvent): undefined {
  worker.postMessage(event);
  return undefined;
}

function fail(error: unknown, id?: number): undefined {
  if (!failure) {
    failure = error instanceof Error ? error.message : String(error);
    if (control && errorBytes) {
      const encoded = new TextEncoder().encodeInto(failure, errorBytes);
      Atomics.store(control, 2, encoded.written);
      Atomics.store(control, 1, 1);
      Atomics.add(control, 0, 1);
      Atomics.notify(control, 0);
    }
  }
  post({ type: "error", message: failure, ...(id === undefined ? {} : { id }) });
  return undefined;
}

async function initialize(fence: SharedArrayBuffer): Promise<undefined> {
  if (control || fence.byteLength !== fenceByteLength) throw new Error("Invalid graphics initialization");
  control = new Int32Array(fence, 0, 3);
  errorBytes = new Uint8Array(fence, fenceErrorOffset);
  if (!navigator.gpu) throw new Error("WebGPU is unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available");
  device = await adapter.requestDevice({ label: "Azahar graphics" });
  device.onuncapturederror = (event): undefined => fail(event.error);
  device.lost.then((info) => { if (!closed) fail(new Error(`WebGPU device lost: ${info.message}`)); });
  shaders = await PicaShaders.create(device);
  if (failure) throw new Error(failure);
  post({ type: "ready", configurationSize: shaders.configurationSize,
    configurationSchema: shaders.configurationSchema });
  return undefined;
}

worker.onmessage = (event: MessageEvent<GraphicsRequest>): undefined => {
  const request = event.data;
  commands = commands.then(async () => {
    try {
      if (closed) throw new Error("The graphics worker is closed");
      if (failure) throw new Error(failure);
      if (request.type === "initialize") return await initialize(request.fence);
      if (!device || !shaders || !control) throw new Error("WebGPU is unavailable");
      switch (request.type) {
        case "surface": {
          const next = await WebGpuPresenter.create(request.canvas, fail, device);
          presenter?.close();
          presenter = next;
          post({ type: "reply", id: request.id });
          break;
        }
        case "video":
          if (!presenter) throw new Error("No WebGPU presentation surface is attached");
          presenter.present(request.bytes, request.width, request.height, request.pitch);
          await device.queue.onSubmittedWorkDone();
          post({ type: "presented" });
          break;
        case "finish":
          await device.queue.onSubmittedWorkDone();
          if (failure) throw new Error(failure);
          Atomics.store(control, 0, request.sequence);
          Atomics.notify(control, 0);
          break;
        case "close":
          await device.queue.onSubmittedWorkDone();
          closed = true;
          presenter?.close();
          shaders.close();
          device.destroy();
          post({ type: "reply", id: request.id });
          worker.close();
          break;
      }
    } catch (error) {
      fail(error, "id" in request ? request.id : undefined);
      if (request.type === "initialize") {
        closed = true;
        shaders?.close();
        device?.destroy();
        worker.close();
      }
    }
    return undefined;
  }).catch(fail);
  return undefined;
};
