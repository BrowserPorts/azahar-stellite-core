// SPDX-License-Identifier: GPL-2.0-or-later

// Opcode and operand fields follow nihstro's pinned shader_bytecode.h.
export const Op = {
  ADD: 0, DP3: 1, DP4: 2, DPH: 3, EX2: 5, LG2: 6, MUL: 8,
  SGE: 9, SLT: 10, FLR: 11, MAX: 12, MIN: 13, RCP: 14, RSQ: 15,
  MOVA: 18, MOV: 19, DPHI: 24, SGEI: 26, SLTI: 27,
  BREAK: 32, NOP: 33, END: 34, BREAKC: 35, CALL: 36, CALLC: 37, CALLU: 38,
  IFU: 39, IFC: 40, LOOP: 41, EMIT: 42, SETEMIT: 43, JMPC: 44, JMPU: 45,
  CMP: 46, MADI: 48, MAD: 56,
} as const;

export function opcode(word: number, pc: number): number {
  if (pc === 4095) return Op.END;
  const raw = word >>> 26;
  return raw >= 48 ? raw & ~7 : raw >= 46 ? Op.CMP : raw;
}
