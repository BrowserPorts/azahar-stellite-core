// SPDX-License-Identifier: GPL-2.0-or-later

import { ArmJitHost } from "../../arm/jit-host";
import { lowerArm, lowerArmRegion } from "../../arm/lower";
import { PicaJitHost } from "../../pica/jit-host";

export interface FixtureRequest {
  url: string;
  assets?: Readonly<Record<string, string>>;
  args: string[];
  dispatch: boolean;
  dsp?: boolean;
  lazyDsp?: boolean;
  regionTier?: boolean;
  firmware?: { name: string; data: Uint8Array }[];
}
export type FixtureReply = { line: string } | { exit: number };

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<FixtureRequest>): Promise<undefined> => {
  const append = (line: string): undefined => {
    worker.postMessage({ line } satisfies FixtureReply);
    return undefined;
  };
  let finished = false;
  const finish = (exit: number): undefined => {
    if (!finished) {
      finished = true;
      worker.postMessage({ exit } satisfies FixtureReply);
    }
    return undefined;
  };
  worker.onunhandledrejection = (event: PromiseRejectionEvent): undefined => {
    if (!finished) {
      append(String(event.reason));
      finish(1);
    }
    return undefined;
  };
  try {
    let dspHost;
    if (event.data.dsp) {
      const dspAsset = (name: string): string => event.data.assets?.[name] ?? new URL(name, event.data.url).href;
      const { DspJitHost } = await import(dspAsset("azahar-dsp-jit.js"));
      const assets = await Promise.all(["azahar-dsp-templates.wasm", "azahar-dsp-families.bin"].map(async (name) => {
        const response = await fetch(dspAsset(name));
        if (!response.ok) throw new Error(`Could not load DSP compiler input ${name}`);
        return new Uint8Array(await response.arrayBuffer());
      }));
      const [templates, families] = assets;
      if (!templates || !families) throw new Error("DSP compiler inputs are missing");
      dspHost = await DspJitHost.create(templates, families, {
        workerUrl: dspAsset("azahar-dsp-optimizer-worker.mjs"),
        compilerUrl: dspAsset("azahar-dsp-optimizer.mjs"),
      });
    }
    const { default: createModule } = await import(event.data.url);
    let linkedBlocks: (() => bigint) | undefined;
    const armJit = new ArmJitHost(event.data.regionTier ? (block, options) => options.execution
      ? lowerArmRegion([block], new Map(), options) : lowerArm(block, options) : undefined);
    if (event.data.regionTier) append("ARM JIT: upstream fixtures use the region compiler");
    await createModule({
      ...(event.data.assets ? {
        locateFileMap: event.data.assets,
        mainScriptUrlOrBlob: event.data.url,
      } : {}),
      ...(dspHost ? { azaharDspJitHost: dspHost } : {}),
      azaharLazyDsp: event.data.lazyDsp ?? false,
      azaharJitHost: armJit,
      azaharPicaJitHost: new PicaJitHost(event.data.dispatch),
      arguments: event.data.args,
      preRun: [(module: { _azahar_arm_jit_linked_blocks?: () => bigint;
        FS: { createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): string;
          createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean): undefined }
      }): undefined => {
        linkedBlocks = module._azahar_arm_jit_linked_blocks;
        if (event.data.firmware?.length) {
          module.FS.createPath("/", "user/sdmc/3ds", true, true);
          for (const { name, data } of event.data.firmware) {
            module.FS.createDataFile("/user/sdmc/3ds", name, data, true, false);
            append(`DSP firmware: ${name}, ${data.byteLength} bytes`);
          }
        }
        return undefined;
      }],
      print: append,
      printErr: append,
      onAbort: (message: string): undefined => {
        append(message);
        finish(1);
        return undefined;
      },
      onExit: (exit: number): undefined => {
        const count = linkedBlocks?.();
        if (count) append(`ARM JIT: ${count} blocks entered through direct Wasm links`);
        const stats = armJit.takeStatistics();
        if (stats.optimizedRegions) append(`ARM JIT: ${stats.optimizedRegions} hot regions compiled as Wasm loops`);
        finish(exit);
        return undefined;
      },
    });
  } catch (error) {
    append(String(error));
    finish(1);
  }
  return undefined;
};
