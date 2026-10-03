// SPDX-License-Identifier: GPL-2.0-or-later

import type binaryen from "binaryen";

export function foldReadOnlyLoads(module: binaryen.Module, memory: Uint8Array<ArrayBufferLike>,
  ranges: readonly (readonly [number, number])[]): number;
