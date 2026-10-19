// SPDX-License-Identifier: GPL-2.0-or-later

addToLibrary({
    $initializeDspRuntime__deps: ["$addRunDependency", "$removeRunDependency"],
    // Synchronous consumers preload the host; JSPI consumers can load it on first use.
    $initializeDspRuntime__postset: `
        if (!ENVIRONMENT_IS_PTHREAD && !Module["azaharDspJitHost"] && !Module["azaharLazyDsp"]) {
            addRunDependency("dsp-jit");
            initializeDspRuntime().then(() => removeRunDependency("dsp-jit")).catch(abort);
        }
    `,
    $initializeDspRuntime: async () => {
        const { DspJitHost } = await import(locateFile("azahar-dsp-jit.js"));
        const assets = await Promise.all(["azahar-dsp-templates.wasm", "azahar-dsp-families.bin"].map(async (name) => {
            const url = locateFile(name);
            if (ENVIRONMENT_IS_NODE) {
                const { readFile } = await import("node:fs/promises");
                return new Uint8Array(await readFile(url.startsWith("file:") ? new URL(url) : url));
            }
            const response = await fetch(url);
            if (!response.ok) throw new Error("Could not load DSP compiler input " + name);
            return new Uint8Array(await response.arrayBuffer());
        }));
        const optimizerAssets = {};
        for (const [key, name] of [["workerUrl", "azahar-dsp-optimizer-worker.mjs"],
                                   ["compilerUrl", "azahar-dsp-optimizer.mjs"]]) {
            const path = locateFile(name);
            optimizerAssets[key] = ENVIRONMENT_IS_NODE
                ? (path.startsWith("file:") ? path : (await import("node:url")).pathToFileURL(path).href)
                : new URL(path, location.href).href;
        }
        Module["azaharDspJitHost"] = await DspJitHost.create(assets[0], assets[1], optimizerAssets);
    },
});
