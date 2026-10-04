// SPDX-License-Identifier: GPL-2.0-or-later

export type Argument = { ref: number } | { imm: string; type: string };
export interface Node {
  op: string;
  type: string;
  args: Argument[];
  binding?: { kind: "access"; addresses: number[] } |
    { kind: "callback"; function: number; userArgument: number };
}
export type Terminal =
  | { kind: "dispatch" | "fast-dispatch" }
  | { kind: "link"; pc: number; cpsr: number; cell?: number; fpscr?: number }
  | { kind: "if"; condition: number; then: Terminal; else: Terminal }
  | { kind: "check-bit"; then: Terminal; else: Terminal }
  | { kind: "check-halt"; else: Terminal };

export interface ArmBlock {
  sourceCell?: number;
  cycles: number;
  condition: number;
  startCpsr?: number;
  startFpscr?: number;
  endCpsr: number;
  conditionFailedPc?: number;
  conditionFailedCpsr?: number;
  conditionFailedCycles?: number;
  conditionFailedCell?: number;
  conditionFailedFpscr?: number;
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
