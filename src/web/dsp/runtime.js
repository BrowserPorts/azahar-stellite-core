// SPDX-License-Identifier: GPL-2.0-or-later

// Emscripten executes this bootstrap in the core and its pthread module factories.
if (!Module["azaharDspJitHost"]) {
    const { DspJitHost } = await import(new URL("azahar-dsp-jit.js", import.meta.url).href);
    const url = new URL("azahar-dsp-templates.wasm", import.meta.url);
    let bytes;
    if (ENVIRONMENT_IS_NODE) {
        const { readFile } = await import("node:fs/promises");
        bytes = new Uint8Array(await readFile(url));
    } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Could not load the DSP opcode templates");
        bytes = new Uint8Array(await response.arrayBuffer());
    }
    Module["azaharDspJitHost"] = new DspJitHost(bytes);
}
