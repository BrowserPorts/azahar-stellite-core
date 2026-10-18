// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../arm/jit-host";
import { PicaJitHost } from "../pica/jit-host";
import { GraphicsClient } from "../gpu/client";

interface QtModule {
  azaharJitHost?: ArmJitHost;
  azaharPicaJitHost?: PicaJitHost;
  azaharGraphicsHost?: GraphicsClient;
}

interface Emulation {
  module: QtModule;
  graphics: GraphicsClient;
  failure?: Error;
}

const worker = self as unknown as DedicatedWorkerGlobalScope & {
  scheduler: { postTask(callback: () => undefined): Promise<undefined> };
};
let emulation: Emulation | undefined;

export async function initializeEmulation(module: QtModule, canvas: OffscreenCanvas): Promise<undefined> {
  if (emulation) throw new Error("Qt emulation is already initialized");
  if (typeof worker.scheduler?.postTask !== "function") {
    throw new Error("Azahar requires browser task scheduling");
  }
  let failure: Error | undefined;
  let state: Emulation | undefined;
  const graphics = await GraphicsClient.create(error => {
    failure = error;
    if (state) state.failure = error;
  });
  try {
    await graphics.surface(canvas);
    if (failure) throw failure;
    module.azaharJitHost = new ArmJitHost();
    module.azaharPicaJitHost = new PicaJitHost();
    module.azaharGraphicsHost = graphics;
    emulation = state = { module, graphics };
  } catch (error) {
    await graphics.close().catch(() => undefined);
    throw error;
  }
  return undefined;
}

export async function yieldEmulation(): Promise<undefined> {
  if (!emulation) throw new Error("Qt emulation is unavailable");
  // Let GPU replies and browser requests run between native frames without timer clamping.
  await worker.scheduler.postTask(() => undefined);
  if (emulation.failure) throw emulation.failure;
  return undefined;
}

export async function shutdownEmulation(): Promise<undefined> {
  if (!emulation) return undefined;
  const { module, graphics } = emulation;
  try { await graphics.close(); }
  finally {
    delete module.azaharJitHost;
    delete module.azaharPicaJitHost;
    delete module.azaharGraphicsHost;
    emulation = undefined;
  }
  return undefined;
}
