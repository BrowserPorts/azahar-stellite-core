// SPDX-License-Identifier: GPL-2.0-or-later

export const runtimeAssetNames = [
  "azahar.js", "azahar-worker.js", "azahar-core.mjs", "azahar-core.wasm",
  "azahar-gpu-worker.js", "azahar-glslang.mjs", "azahar-glslang.wasm",
  "azahar-shader-compiler.wasm", "azahar-pica-shaders.mjs", "azahar-pica-shaders.wasm",
  "azahar-dsp-templates.wasm", "azahar-dsp-families.bin", "azahar-dsp-jit.js",
  "azahar-dsp-optimizer-worker.mjs", "azahar-dsp-optimizer.mjs",
  "azahar-audio-worklet.js", "azahar-microphone-worklet.js",
] as const;

export type RuntimeAssetName = typeof runtimeAssetNames[number];
export type RuntimeAssets = Readonly<Record<RuntimeAssetName, string>>;
export type RuntimeAssetOverrides = Readonly<Partial<RuntimeAssets>>;

/** Resolve on the host before passing URLs to workers, including installed blob assets. */
export function resolveRuntimeAssets(base: string, overrides: RuntimeAssetOverrides = {}): RuntimeAssets {
  return Object.fromEntries(runtimeAssetNames.map(name => {
    try { return [name, new URL(overrides[name] ?? name, base).href]; }
    catch (error) { throw new Error(`Azahar runtime asset URL is unavailable: ${name}`, { cause: error }); }
  })) as RuntimeAssets;
}

export interface WasmAssetOptions {
  locateFileMap?: RuntimeAssets;
  mainScriptUrlOrBlob?: string;
}

/** Emscripten uses the loader URL again when creating native pthread workers. */
export function wasmAssetOptions(assets: RuntimeAssets | undefined, loader: RuntimeAssetName): WasmAssetOptions {
  if (!assets) return {};
  return {
    locateFileMap: assets,
    mainScriptUrlOrBlob: assets[loader],
  };
}
