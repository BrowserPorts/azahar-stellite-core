// SPDX-License-Identifier: GPL-2.0-or-later

export type Argument = { ref: number } | { imm: string; type: string };
export interface Node {
  op: string;
  type: string;
  args: Argument[];
}
export type Terminal =
  | { kind: "dispatch" }
  | { kind: "link"; pc: number; cpsr: number }
  | { kind: "if"; condition: number; then: Terminal; else: Terminal }
  | { kind: "check-bit"; then: Terminal; else: Terminal }
  | { kind: "check-halt"; else: Terminal };

export interface ArmBlock {
  cycles: number;
  condition: number;
  conditionFailedPc?: number;
  conditionFailedCycles?: number;
  terminal: Terminal;
  nodes: Node[];
}

export interface ArmLayout {
  registers: number;
  cpsr: number;
  extendedRegisters: number;
  fpscr: number;
  checkBit: number;
}
