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
      const assets = await Promise.all(["azahar-dsp-templates.wasm", "azahar-dsp-families.bin"].map(async (name) => {
        const response = await fetch(new URL(name, event.data.url));
        if (!response.ok) throw new Error(`Could not load DSP compiler input ${name}`);
        return new Uint8Array(await response.arrayBuffer());
      }));
      const [templates, families] = assets;
      if (!templates || !families) throw new Error("DSP compiler inputs are missing");
      dspHost = await DspJitHost.create(templates, families);
    }
    const { default: createModule } = await import(event.data.url);
    let linkedBlocks: (() => bigint) | undefined;
    await createModule({
      ...(dspHost ? { azaharDspJitHost: dspHost } : {}),
      azaharJitHost: new ArmJitHost(),
      azaharPicaJitHost: new PicaJitHost(event.data.dispatch),
      arguments: event.data.args,
      preRun: [(module: { _azahar_arm_jit_linked_blocks?: () => bigint }): undefined => {
        linkedBlocks = module._azahar_arm_jit_linked_blocks;
        return undefined;
      }],
      print: append,
      printErr: append,
      onAbort: (message: string): undefined => {
        append(message);
        worker.postMessage({ exit: 1 } satisfies FixtureReply);
        return undefined;
      },
      onExit: (exit: number): undefined => {
        const count = linkedBlocks?.();
        if (count) append(`ARM JIT: ${count} blocks entered through direct Wasm links`);
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
