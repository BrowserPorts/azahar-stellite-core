// SPDX-License-Identifier: GPL-2.0-or-later

export const JIT_ABI_VERSION = 1;
export const COMPILER_PROTOCOL_VERSION = 2;
export type Engine = "arm11" | "pica" | "teak";
export type Tier = 1 | 2;

export interface CodeDependency {
  address: number;
  generation: number;
}

export interface CompileRequest {
  version: typeof COMPILER_PROTOCOL_VERSION;
  type: "compile";
  id: number;
  engine: Engine;
  tier: Tier;
  pc: number;
  mode: number;
  abi: number;
  source: ArrayBuffer;
  layout: Uint32Array;
  dependencies: CodeDependency[];
}

export interface CompiledRegion {
  version: typeof COMPILER_PROTOCOL_VERSION;
  type: "compiled";
  id: number;
  module: WebAssembly.Module;
  entries: Uint32Array;
  generatedBytes: number;
  dependencies: CodeDependency[];
}

export interface CompileFailure {
  version: typeof COMPILER_PROTOCOL_VERSION;
  type: "compile-error";
  id: number;
  message: string;
}

export type CompileResponse = CompiledRegion | CompileFailure;

export interface TranslatorOutput {
  bytes: Uint8Array<ArrayBuffer>;
  entries: Uint32Array;
}

export interface RegionTranslator {
  compile(request: CompileRequest): TranslatorOutput | Promise<TranslatorOutput>;
}

export class JitError extends Error {
  constructor(
    public readonly code: "capability" | "protocol" | "compile" | "stale" | "capacity" | "disposed",
    message: string,
  ) {
    super(message);
    this.name = "JitError";
  }
}

function isU32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff;
}

export function validateRequest(value: unknown): asserts value is CompileRequest {
  if (value === null || typeof value !== "object") {
    throw new JitError("protocol", "Invalid compiler request");
  }
  const request = value as Partial<CompileRequest>;
  if (
    request.version !== COMPILER_PROTOCOL_VERSION || request.type !== "compile" ||
    !isU32(request.id) || !isU32(request.pc) || !isU32(request.mode) ||
    request.abi !== JIT_ABI_VERSION ||
    !["arm11", "pica", "teak"].includes(request.engine ?? "") ||
    (request.tier !== 1 && request.tier !== 2) ||
    !(request.source instanceof ArrayBuffer) || request.source.byteLength === 0 ||
    request.source.byteLength > 4 * 1024 * 1024 ||
    !(request.layout instanceof Uint32Array) || request.layout.length > 256 ||
    !Array.isArray(request.dependencies) || request.dependencies.length > 1024
  ) {
    throw new JitError("protocol", "Invalid compiler request fields");
  }
  for (const dependency of request.dependencies) {
    if (!dependency || !isU32(dependency.address) || !isU32(dependency.generation)) {
      throw new JitError("protocol", "Invalid code dependency");
    }
  }
}

export async function compileRequest(
  value: unknown,
  translators: Partial<Record<Engine, RegionTranslator>>,
): Promise<CompileResponse> {
  let id = 0;
  try {
    validateRequest(value);
    id = value.id;
    const translator = translators[value.engine];
    if (!translator) {
      throw new JitError("compile", `No ${value.engine} Wasm translator is installed`);
    }
    const output = await translator.compile(value);
    if (output.entries.length === 0 || !output.entries.includes(value.pc)) {
      throw new JitError("compile", "Generated region is missing its requested entry point");
    }
    const module = await WebAssembly.compile(output.bytes);
    return {
      version: COMPILER_PROTOCOL_VERSION,
      type: "compiled",
      id,
      module,
      entries: output.entries,
      generatedBytes: output.bytes.byteLength,
      dependencies: value.dependencies.map((dependency) => ({ ...dependency })),
    };
  } catch (error) {
    if (value && typeof value === "object" && isU32((value as { id?: unknown }).id)) {
      id = (value as { id: number }).id;
    }
    return {
      version: COMPILER_PROTOCOL_VERSION,
      type: "compile-error",
      id,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
