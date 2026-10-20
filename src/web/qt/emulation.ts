// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../arm/jit-host";
import { PicaJitHost } from "../pica/jit-host";
import { GraphicsClient } from "../gpu/client";
import { QtAudioProducer } from "./audio";
import type { AudioTransport } from "../runtime/audio-ring";
import { MicrophoneConsumer } from "../runtime/microphone-ring";
import type { MicrophoneTransport } from "../runtime/microphone-ring";

interface QtModule {
  HEAP16: Int16Array<SharedArrayBuffer>;
  azaharJitHost?: ArmJitHost;
  azaharPicaJitHost?: PicaJitHost;
  azaharGraphicsHost?: GraphicsClient;
  azaharQtAudioProducer?: QtAudioProducer;
  azaharQtAudioTransport?: AudioTransport;
  azaharQtAudioConnection?: number;
  azaharQtAudioResume?: number;
  azaharMicrophoneRead?: (pointer: number, count: number) => number;
  azaharMicrophoneActive?: (active: boolean) => undefined;
  azaharMicrophoneClosed?: () => undefined;
  azaharQtMicrophoneConnection?: number;
  azaharQtMicrophoneTransport?: MicrophoneTransport;
}

interface Emulation {
  module: QtModule;
  graphics: GraphicsClient;
  microphone: MicrophoneConsumer;
  failure?: Error;
}

const worker = self as unknown as DedicatedWorkerGlobalScope & {
  scheduler: { postTask(callback: () => undefined): Promise<undefined> };
};
let emulation: Emulation | undefined;

export async function initializeEmulation(module: QtModule, canvases: readonly OffscreenCanvas[]): Promise<undefined> {
  if (emulation) throw new Error("Qt emulation is already initialized");
  if (!canvases[0] || canvases.length > 2) throw new Error("Invalid Qt render surfaces");
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
    await graphics.surface(canvases[0]);
    if (canvases[1]) await graphics.surface(canvases[1], 1);
    if (failure) throw failure;
    module.azaharJitHost = new ArmJitHost();
    module.azaharPicaJitHost = new PicaJitHost();
    module.azaharGraphicsHost = graphics;
    const microphone = new MicrophoneConsumer();
    module.azaharMicrophoneRead = (pointer, count) => microphone.read(module.HEAP16.subarray(
      pointer >>> 1, (pointer >>> 1) + count));
    module.azaharMicrophoneActive = active => {
      microphone.active(active);
      worker.postMessage({ azaharQtMicrophoneActive: active,
        azaharQtMicrophoneConnection: module.azaharQtMicrophoneConnection });
      return undefined;
    };
    module.azaharMicrophoneClosed = () => {
      worker.postMessage({ azaharQtMicrophoneActive: false, azaharQtMicrophoneClosed: true,
        azaharQtMicrophoneConnection: module.azaharQtMicrophoneConnection });
      return undefined;
    };
    emulation = state = { module, graphics, microphone };
    connectAudio(module);
    connectMicrophone(module);
  } catch (error) {
    await graphics.close().catch(() => undefined);
    throw error;
  }
  return undefined;
}

export function connectAudio(module: QtModule): undefined {
  if (emulation?.module !== module || !module.azaharQtAudioTransport) return undefined;
  module.azaharQtAudioProducer = new QtAudioProducer(module.azaharQtAudioTransport);
  module.azaharQtAudioProducer.clear();
  if (module.azaharQtAudioResume) resumeAudio(module);
  return undefined;
}

export function resumeAudio(module: QtModule): undefined {
  if (emulation?.module !== module || !module.azaharQtAudioProducer ||
    module.azaharQtAudioResume !== module.azaharQtAudioConnection) return undefined;
  module.azaharQtAudioProducer.resume();
  delete module.azaharQtAudioResume;
  worker.postMessage({ azaharQtAudioReady: module.azaharQtAudioConnection });
  return undefined;
}

export function connectMicrophone(module: QtModule): undefined {
  if (emulation?.module !== module || !module.azaharQtMicrophoneTransport) return undefined;
  emulation.microphone.attach(module.azaharQtMicrophoneTransport);
  emulation.microphone.running(true);
  delete module.azaharQtMicrophoneTransport;
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
  const { module, graphics, microphone } = emulation;
  try { await graphics.close(); }
  finally {
    microphone.close();
    delete module.azaharMicrophoneRead;
    delete module.azaharMicrophoneActive;
    delete module.azaharMicrophoneClosed;
    delete module.azaharQtMicrophoneConnection;
    delete module.azaharQtMicrophoneTransport;
    module.azaharQtAudioProducer?.clear();
    delete module.azaharQtAudioProducer;
    delete module.azaharQtAudioTransport;
    delete module.azaharQtAudioConnection;
    delete module.azaharQtAudioResume;
    delete module.azaharJitHost;
    delete module.azaharPicaJitHost;
    delete module.azaharGraphicsHost;
    emulation = undefined;
  }
  return undefined;
}
