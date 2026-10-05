// SPDX-License-Identifier: GPL-2.0-or-later

import type { GraphicsCommand, GraphicsEvent, GraphicsRequest } from "./messages";
import { fenceByteLength, fenceErrorOffset } from "./messages";
import { PicaShaders } from "./pica-shaders";
import { WebGpuPresenter } from "./presenter";
import { GraphicsTextures } from "./textures";
import { GraphicsSamplers } from "./samplers";
import { GraphicsDraws } from "./draws";
import { unpackNativeDraw } from "./draw-types";
import { GraphicsScreens } from "./screens";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let commands: Promise<unknown> = Promise.resolve();
let control: Int32Array<SharedArrayBuffer> | undefined;
let errorBytes: Uint8Array<SharedArrayBuffer> | undefined;
let device: GPUDevice | undefined;
let shaders: PicaShaders | undefined;
let presenter: WebGpuPresenter | undefined;
let textures: GraphicsTextures | undefined;
let samplers: GraphicsSamplers | undefined;
let draws: GraphicsDraws | undefined;
let screens: GraphicsScreens | undefined;
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
  if (!adapter.features.has("clip-distances")) throw new Error("WebGPU clip distances are required for PICA clipping");
  device = await adapter.requestDevice({ label: "Azahar graphics", requiredFeatures: ["clip-distances"] });
  device.onuncapturederror = (event): undefined => fail(event.error);
  device.lost.then((info) => { if (!closed) fail(new Error(`WebGPU device lost: ${info.message}`)); });
  shaders = await PicaShaders.create(device);
  textures = await GraphicsTextures.create(device);
  samplers = new GraphicsSamplers(device);
  draws = await GraphicsDraws.create(device, shaders, textures, samplers);
  screens = await GraphicsScreens.create(device, textures);
  if (failure) throw new Error(failure);
  const info = adapter.info;
  post({ type: "ready", configurationSize: shaders.configurationSize,
    configurationSchema: shaders.configurationSchema, adapter: {
      vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter,
    } });
  return undefined;
}

async function execute(request: GraphicsCommand): Promise<undefined> {
  try {
    if (closed) throw new Error("The graphics worker is closed");
    if (failure) throw new Error(failure);
    if (request.type === "initialize") return await initialize(request.fence);
    if (!device || !shaders || !textures || !samplers || !draws || !screens || !control) throw new Error("WebGPU is unavailable");
    // Submit prior draws before a queue write, resource mutation, presentation, or fence.
    if (request.type !== "draw") draws.flush();
    switch (request.type) {
      case "vertex-program-create": await shaders.createVertexProgram(request.handle, request.source); break;
      case "vertex-program-destroy": shaders.destroyVertexProgram(request.handle); break;
      case "draw": await draws.draw(unpackNativeDraw(request.bytes, shaders.configurationSize,
        request.program, request.picaUniforms)); break;
      case "lookup-table": draws.lookupTable(request.table, request.offset, request.bytes); break;
      case "sampler-create": samplers.create(request.handle, request.params); break;
      case "sampler-destroy": samplers.destroy(request.handle); break;
      case "texture-create":
        textures.create(request.handle, request.width, request.height, request.levels, request.layers, request.format);
        break;
      case "texture-destroy": textures.destroy(request.handle); break;
      case "texture-copy": await textures.copy(request.source, request.dest, request.src, request.dst); break;
      case "texture-blit": await textures.blit(request.source, request.dest, request.src, request.dst); break;
      case "texture-mipmaps": await textures.mipmaps(request.handle); break;
      case "texture-clear": await textures.clear(request.handle, request.region, request.value, request.stencil); break;
      case "texture-upload": await textures.upload(request.handle, request.region, request.bytes); break;
      case "texture-download": {
        await textures.download(request.handle, request.region, request.destination);
        if (failure) throw new Error(failure);
        Atomics.store(control, 0, request.sequence);
        Atomics.notify(control, 0);
        break;
      }
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
        // Retain the frame limit while later commands are submitted in queue order.
        device.queue.onSubmittedWorkDone().then(() => post({ type: "presented" }), fail);
        break;
      case "screens":
        if (!presenter) throw new Error("No WebGPU presentation surface is attached");
        presenter.screens(request.frame, screens);
        device.queue.onSubmittedWorkDone().then(() => post({ type: "presented" }), fail);
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
        draws.close();
        screens.close();
        shaders.close();
        textures.close();
        samplers.close();
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
      draws?.close();
      screens?.close();
      textures?.close();
      samplers?.close();
      device?.destroy();
      worker.close();
    }
  }
  return undefined;
}

worker.onmessage = (event: MessageEvent<GraphicsRequest>): undefined => {
  const requests = event.data.commands;
  commands = commands.then(async () => {
    for (const request of requests) await execute(request);
    if (!failure && !closed) draws?.flush();
    return undefined;
  }).catch(fail);
  return undefined;
};
