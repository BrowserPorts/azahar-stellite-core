// SPDX-License-Identifier: GPL-2.0-or-later

addToLibrary({
    $initializeDspRuntime__deps: ["$addRunDependency", "$removeRunDependency"],
    // Prepare synchronous core calls; pthreads load the compiler on their first DSP call.
    $initializeDspRuntime__postset: `
        if (!ENVIRONMENT_IS_PTHREAD && !Module["azaharDspJitHost"]) {
            addRunDependency("dsp-jit");
            initializeDspRuntime().then(() => removeRunDependency("dsp-jit")).catch(abort);
        }
    `,
    $initializeDspRuntime: async () => {
        const { DspJitHost } = await import(new URL("azahar-dsp-jit.js", import.meta.url).href);
        const assets = await Promise.all(["azahar-dsp-templates.wasm", "azahar-dsp-families.bin"].map(async (name) => {
            const url = new URL(name, import.meta.url);
            if (ENVIRONMENT_IS_NODE) {
                const { readFile } = await import("node:fs/promises");
                return new Uint8Array(await readFile(url));
            }
            const response = await fetch(url);
            if (!response.ok) throw new Error("Could not load DSP compiler input " + name);
            return new Uint8Array(await response.arrayBuffer());
        }));
        Module["azaharDspJitHost"] = await DspJitHost.create(assets[0], assets[1]);
    },
});
