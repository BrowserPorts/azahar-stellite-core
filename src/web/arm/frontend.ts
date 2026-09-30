// SPDX-License-Identifier: GPL-2.0-or-later

import { JitError } from "../protocol";
import type { CompileRequest } from "../protocol";
import type { ArmBlock } from "./ir";

export interface ArmFrontendModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): unknown;
  _azahar_translate(bytes: number, size: number, pc: number, cpsr: number, fpscr: number, limit: number): number;
  _azahar_result_size(): number;
}

export class ArmFrontend {
  constructor(readonly module: ArmFrontendModule) {}

  translate(request: CompileRequest): ArmBlock {
    const pointer = this.module._malloc(request.source.byteLength);
    if (!pointer) throw new JitError("capacity", "The ARM compiler ran out of memory");
    try {
      this.module.HEAPU8.set(new Uint8Array(request.source), pointer);
      const result = this.module._azahar_translate(
        pointer, request.source.byteLength, request.pc, request.mode,
        request.layout[5] ?? 0, request.tier === 2 ? 256 : 32,
      );
      const bytes = this.module.HEAPU8.subarray(result, result + this.module._azahar_result_size());
      const block = JSON.parse(new TextDecoder().decode(bytes)) as ArmBlock | { error: string };
      if ("error" in block) throw new JitError("compile", block.error);
      return block;
    } finally {
      this.module._free(pointer);
    }
  }
}
