// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../../arm/jit-host";
import { PicaJitHost } from "../../pica/jit-host";

export interface FixtureRequest {
  url: string;
  args: string[];
  dispatch: boolean;
  dsp?: boolean;
}
export type FixtureReply = { line: string } | { exit: number };

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<FixtureRequest>): Promise<undefined> => {
  const append = (line: string): undefined => {
    worker.postMessage({ line } satisfies FixtureReply);
    return undefined;
  };
  try {
    let dspHost;
    if (event.data.dsp) {
      const { DspJitHost } = await import(new URL("azahar-dsp-jit.js", event.data.url).href);
      const response = await fetch(new URL("azahar-dsp-templates.wasm", event.data.url));
      if (!response.ok) throw new Error("Could not load the DSP opcode templates");
      dspHost = new DspJitHost(new Uint8Array(await response.arrayBuffer()));
    }
    const { default: createModule } = await import(event.data.url);
    await createModule({
      ...(dspHost ? { azaharDspJitHost: dspHost } : {}),
      azaharJitHost: new ArmJitHost(),
      azaharPicaJitHost: new PicaJitHost(event.data.dispatch),
      arguments: event.data.args,
      print: append,
      printErr: append,
      onAbort: (message: string): undefined => {
        append(message);
        worker.postMessage({ exit: 1 } satisfies FixtureReply);
        return undefined;
      },
      onExit: (exit: number): undefined => {
        worker.postMessage({ exit } satisfies FixtureReply);
        return undefined;
      },
    });
  } catch (error) {
    append(String(error));
    worker.postMessage({ exit: 1 } satisfies FixtureReply);
  }
  return undefined;
};
