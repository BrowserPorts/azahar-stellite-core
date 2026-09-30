// SPDX-License-Identifier: GPL-2.0-or-later

import { JitError } from "../protocol";
import { Bytes, regionModule } from "../wasm/binary";
import type { FunctionImport, ValueType } from "../wasm/binary";
import type { Argument, ArmBlock, ArmLayout, Terminal } from "./ir";

const binary: Record<string, number> = {
  Mul32: 0x6c, And32: 0x71, Eor32: 0x73, Or32: 0x72,
  Mul64: 0x7e, And64: 0x83, Eor64: 0x85, Or64: 0x84,
  LogicalShiftLeftMasked32: 0x74, LogicalShiftRightMasked32: 0x76,
  ArithmeticShiftRightMasked32: 0x75, RotateRightMasked32: 0x78,
  LogicalShiftLeftMasked64: 0x86, LogicalShiftRightMasked64: 0x88,
  ArithmeticShiftRightMasked64: 0x87, RotateRightMasked64: 0x8a,
};

function wasmType(type: string): ValueType {
  return type === "U64" || type === "CoprocInfo" ? "i64" : type === "U128" ? "v128" : "i32";
}

export interface LowerOptions {
  layout: ArmLayout;
  shared: boolean;
  maximumPages: number;
  /** Explicit arithmetic/peripheral helpers exported as raw Wasm functions by the core. */
  helperNames?: ReadonlySet<string>;
}

export function lowerArm(block: ArmBlock, options: LowerOptions): Uint8Array<ArrayBuffer> {
  const body = new Bytes();
  const imports: FunctionImport[] = [];
  const locals: ValueType[] = block.nodes.map((node) => wasmType(node.type));
  const carryLocals = new Map<number, number>();
  const wideLocals = new Map<number, number>();
  block.nodes.forEach((node, index) => {
    if (["Add32", "Sub32"].includes(node.op)) {
      wideLocals.set(index, locals.length + 2);
      locals.push("i64");
    } else if (["LogicalShiftLeft32", "LogicalShiftRight32", "ArithmeticShiftRight32", "RotateRight32", "RotateRightExtended"].includes(node.op)) {
      carryLocals.set(index, locals.length + 2);
      locals.push("i32");
    }
  });
  const constant = (value: number): Bytes => body.byte(0x41).signed(BigInt(value), 32);
  const get = (index: number): Bytes => body.byte(0x20).u32(index);
  const set = (index: number): Bytes => body.byte(0x21).u32(index);
  const load = (offset: number, wide = false): Bytes =>
    get(0).byte(wide ? 0x29 : 0x28).u32(wide ? 3 : 2).u32(offset);
  const store = (offset: number, value: () => unknown, wide = false): undefined => {
    get(0); value(); body.byte(wide ? 0x37 : 0x36).u32(wide ? 3 : 2).u32(offset);
    return undefined;
  };
  const argument = (value: Argument): undefined => {
    if ("ref" in value) {
      if (!block.nodes[value.ref]) throw new JitError("compile", "Invalid ARM IR reference");
      get(value.ref + 2);
    } else {
      const wide = wasmType(value.type) === "i64";
      body.byte(wide ? 0x42 : 0x41).signed(BigInt(value.imm), wide ? 64 : 32);
    }
    return undefined;
  };
  const argType = (value: Argument): ValueType => "ref" in value
    ? wasmType(block.nodes[value.ref]!.type) : wasmType(value.type);
  const helper = (name: string, params: ValueType[], results: ValueType[], emit: () => unknown): undefined => {
    if (!options.helperNames?.has(name)) throw new JitError("compile", `ARM Wasm lowering is missing ${name}`);
    let importIndex = imports.findIndex((item) => item.name === name);
    if (importIndex < 0) {
      importIndex = imports.length;
      imports.push({ module: "core", name, type: { params: ["i32", ...params], results } });
    }
    get(0); emit(); body.byte(0x10).u32(importIndex);
    return undefined;
  };
  const bit = (mask: number): Bytes => load(options.layout.cpsr).byte(0x41)
    .signed(BigInt(mask), 32).byte(0x71).byte(0x45).byte(0x45);
  const condition = (code: number): undefined => {
    switch (code) {
      case 0: bit(0x40000000); break;
      case 1: bit(0x40000000).byte(0x45); break;
      case 2: bit(0x20000000); break;
      case 3: bit(0x20000000).byte(0x45); break;
      case 4: bit(0x80000000); break;
      case 5: bit(0x80000000).byte(0x45); break;
      case 6: bit(0x10000000); break;
      case 7: bit(0x10000000).byte(0x45); break;
      case 8: bit(0x20000000); bit(0x40000000).byte(0x45).byte(0x71); break;
      case 9: bit(0x20000000).byte(0x45); bit(0x40000000).byte(0x72); break;
      case 10: bit(0x80000000); bit(0x10000000).byte(0x46); break;
      case 11: bit(0x80000000); bit(0x10000000).byte(0x47); break;
      case 12: bit(0x40000000).byte(0x45); bit(0x80000000); bit(0x10000000).byte(0x46).byte(0x71); break;
      case 13: bit(0x40000000); bit(0x80000000); bit(0x10000000).byte(0x47).byte(0x72); break;
      case 14: constant(1); break;
      case 15: constant(0); break;
      default: throw new JitError("compile", "Invalid ARM condition");
    }
    return undefined;
  };
  const consume = (cycles: number): Bytes => get(1).byte(0x42).signed(BigInt(cycles), 64).byte(0x7d);
  const mergeFlags = (mask: number, value: () => unknown): undefined => store(options.layout.cpsr, () => {
    load(options.layout.cpsr); constant(~mask).byte(0x71);
    value(); constant(mask).byte(0x71).byte(0x72);
  });
  const immediate = (value: Argument): number => {
    if (!("imm" in value)) throw new JitError("compile", "Expected a constant ARM register index");
    return Number(BigInt(value.imm));
  };
  const carry = (reference: number): undefined => {
    const wide = wideLocals.get(reference);
    const shift = carryLocals.get(reference);
    if (wide !== undefined) get(wide).byte(0x42).signed(32n, 64).byte(0x88).byte(0xa7);
    else if (shift !== undefined) get(shift);
    else throw new JitError("compile", `Missing carry lowering for ${block.nodes[reference]?.op}`);
    return undefined;
  };
  const overflow = (reference: number): undefined => {
    const source = block.nodes[reference]!;
    if (source.op !== "Add32" && source.op !== "Sub32") {
      throw new JitError("compile", `Missing overflow lowering for ${source.op}`);
    }
    argument(source.args[0]!); argument(source.args[1]!); body.byte(0x73);
    if (source.op === "Add32") constant(-1).byte(0x73);
    argument(source.args[0]!); get(reference + 2).byte(0x73).byte(0x71);
    constant(31).byte(0x76);
    return undefined;
  };
  const shift32 = (op: string, index: number, arg: (position: number) => undefined): undefined => {
    const outputCarry = carryLocals.get(index)!;
    const carryBit = (): Bytes => constant(1).byte(0x71);
    if (op === "RotateRightExtended") {
      arg(0); carryBit(); set(outputCarry);
      arg(0); constant(1).byte(0x76); arg(1); constant(31).byte(0x74).byte(0x72);
      return undefined;
    }
    arg(1); body.byte(0x45).byte(0x04).byte(0x7f);
    arg(2); set(outputCarry); arg(0);
    body.byte(0x05);
    if (op === "RotateRight32") {
      arg(0); arg(1); body.byte(0x78).byte(0x22).u32(index + 2);
      get(index + 2); constant(31).byte(0x76); set(outputCarry);
    } else if (op === "ArithmeticShiftRight32") {
      arg(0); arg(1); constant(1).byte(0x6b); constant(31);
      arg(1); constant(32).byte(0x49).byte(0x1b).byte(0x76); carryBit(); set(outputCarry);
      arg(0); arg(1); constant(31); arg(1); constant(32).byte(0x49).byte(0x1b).byte(0x75);
    } else {
      arg(1); constant(32).byte(0x49).byte(0x04).byte(0x7f);
      arg(0);
      if (op === "LogicalShiftLeft32") constant(32); else arg(1);
      if (op === "LogicalShiftLeft32") arg(1); else constant(1);
      body.byte(0x6b).byte(0x76); carryBit(); set(outputCarry);
      arg(0); arg(1); body.byte(op === "LogicalShiftLeft32" ? 0x74 : 0x76);
      body.byte(0x05);
      arg(0);
      if (op === "LogicalShiftRight32") constant(31).byte(0x76);
      carryBit(); constant(0); arg(1); constant(32).byte(0x46).byte(0x1b); set(outputCarry);
      constant(0); body.byte(0x0b);
    }
    body.byte(0x0b);
    return undefined;
  };
  const terminal = (term: Terminal): undefined => {
    switch (term.kind) {
      case "link":
        store(options.layout.registers + 60, () => constant(term.pc));
        mergeFlags(0x0600fe20, () => constant(term.cpsr));
        break;
      case "dispatch": break;
      case "if":
        condition(term.condition); body.byte(0x04).byte(0x40);
        terminal(term.then); body.byte(0x05); terminal(term.else); body.byte(0x0b);
        break;
      case "check-bit":
        load(options.layout.checkBit); body.byte(0x04).byte(0x40);
        terminal(term.then); body.byte(0x05); terminal(term.else); body.byte(0x0b);
        break;
      case "check-halt":
        // The block is bounded; the dispatcher checks halt state before the next block.
        terminal(term.else);
        break;
    }
    return undefined;
  };
  get(1).byte(0x42).signed(0n, 64).byte(0x57).byte(0x04).byte(0x40);
  get(1).byte(0x0f).byte(0x0b);
  if (block.condition !== 14) {
    if (block.conditionFailedPc === undefined || block.conditionFailedCycles === undefined) {
      throw new JitError("compile", "Conditional ARM block is missing its failure location");
    }
    condition(block.condition); body.byte(0x45).byte(0x04).byte(0x40);
    store(options.layout.registers + 60, () => constant(block.conditionFailedPc!));
    consume(block.conditionFailedCycles).byte(0x0f).byte(0x0b);
  }
  block.nodes.forEach((node, index) => {
    const arg = (position: number): undefined => argument(node.args[position]!);
    let result = node.type !== "Void";
    if (binary[node.op] !== undefined) {
      arg(0); arg(1); body.byte(binary[node.op]!);
    } else switch (node.op) {
      case "Void": case "PushRSB": case "A32UpdateUpperLocationDescriptor": result = false; break;
      case "Identity": arg(0); break;
      case "A32GetRegister": load(options.layout.registers + immediate(node.args[0]!) * 4); break;
      case "A32SetRegister": store(options.layout.registers + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister32": load(options.layout.extendedRegisters + immediate(node.args[0]!) * 4); break;
      case "A32SetExtendedRegister32": store(options.layout.extendedRegisters + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister64": load(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, true); break;
      case "A32SetExtendedRegister64": store(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, () => arg(1), true); break;
      case "A32GetCpsr": load(options.layout.cpsr); break;
      case "A32SetCpsr": store(options.layout.cpsr, () => arg(0)); break;
      case "A32CoprocGetOneWord": case "A32CoprocGetTwoWords":
      case "A32CoprocSendOneWord": case "A32CoprocSendTwoWords":
      case "A32CoprocInternalOperation": case "A32CoprocLoadWords": case "A32CoprocStoreWords": {
        const binding = node.binding;
        if (!binding) throw new JitError("compile", "Coprocessor is missing its compiled binding");
        if (binding.kind === "callback") {
          helper("WasmCallCoprocessor", ["i32", "i32", "i32", "i32"], ["i64"], () => {
            constant(binding.function); constant(binding.userArgument);
            if (node.args[1]) arg(1); else constant(0);
            if (node.args[2]) arg(2); else constant(0);
          });
          if (!result) body.byte(0x1a);
          else if (node.type !== "U64") body.byte(0xa7);
        } else {
          const count = node.op.endsWith("TwoWords") ? 2 : 1;
          if (binding.addresses.length !== count) throw new JitError("compile", "Invalid coprocessor register binding");
          for (let word = 0; word < count; ++word) {
            constant(binding.addresses[word]!);
            if (result) {
              body.byte(0x28).u32(2).u32(0);
              if (count === 2) {
                body.byte(0xad);
                if (word === 1) body.byte(0x42).signed(32n, 64).byte(0x86).byte(0x84);
              }
            } else { arg(word + 1); body.byte(0x36).u32(2).u32(0); }
          }
        }
        break;
      }
      case "A32BXWritePC":
        store(options.layout.registers + 60, () => {
          arg(0); constant(-2); constant(-4); arg(0); constant(1).byte(0x71).byte(0x1b).byte(0x71);
        });
        mergeFlags(0x20, () => { arg(0); constant(1).byte(0x71); constant(5).byte(0x74); });
        break;
      case "A32GetFpscr": load(options.layout.fpscr); break;
      case "A32SetFpscr": store(options.layout.fpscr, () => arg(0)); break;
      case "A32GetFpscrNZCV": load(options.layout.fpscr); constant(0xf0000000).byte(0x71); break;
      case "A32SetFpscrNZCV": store(options.layout.fpscr, () => {
        load(options.layout.fpscr); constant(0x0fffffff).byte(0x71);
        arg(0); constant(0xf0000000).byte(0x71).byte(0x72);
      }); break;
      case "A32GetCFlag": bit(0x20000000); break;
      case "A32SetCheckBit": store(options.layout.checkBit, () => arg(0)); break;
      case "A32SetCpsrNZCV": case "A32SetCpsrNZCVRaw": mergeFlags(0xf0000000, () => arg(0)); break;
      case "A32SetCpsrNZCVQ": mergeFlags(0xf8000000, () => arg(0)); break;
      case "A32SetCpsrNZ": mergeFlags(0xc0000000, () => arg(0)); break;
      case "A32SetCpsrNZC": mergeFlags(0xe0000000, () => {
        arg(0); constant(0xc0000000).byte(0x71); arg(1); constant(29).byte(0x74).byte(0x72);
      }); break;
      case "A32OrQFlag": mergeFlags(0x08000000, () => {
        load(options.layout.cpsr); arg(0); constant(27).byte(0x74).byte(0x72);
      }); break;
      case "NZCVFromPackedFlags": arg(0); break;
      case "GetCFlagFromNZCV": arg(0); constant(29).byte(0x76); constant(1).byte(0x71); break;
      case "GetCarryFromOp": carry((node.args[0] as { ref: number }).ref); break;
      case "GetOverflowFromOp": overflow((node.args[0] as { ref: number }).ref); break;
      case "GetNZFromOp": case "GetNZCVFromOp": {
        const reference = (node.args[0] as { ref: number }).ref;
        arg(0);
        if (argType(node.args[0]!) === "i64") body.byte(0x42).signed(32n, 64).byte(0x88).byte(0xa7);
        constant(0x80000000).byte(0x71);
        arg(0); body.byte(argType(node.args[0]!) === "i64" ? 0x50 : 0x45);
        constant(30).byte(0x74).byte(0x72);
        if (node.op === "GetNZCVFromOp" && wideLocals.has(reference)) {
          carry(reference); constant(29).byte(0x74).byte(0x72);
          overflow(reference); constant(28).byte(0x74).byte(0x72);
        }
        break;
      }
      case "Add32": case "Sub32":
        arg(0); body.byte(0xad); arg(1);
        if (node.op === "Sub32") constant(-1).byte(0x73);
        body.byte(0xad).byte(0x7c); arg(2); body.byte(0xad).byte(0x7c);
        body.byte(0x22).u32(wideLocals.get(index)!).byte(0xa7);
        break;
      case "LogicalShiftLeft32": case "LogicalShiftRight32": case "ArithmeticShiftRight32":
      case "RotateRight32": case "RotateRightExtended": shift32(node.op, index, arg); break;
      case "AndNot32": case "AndNot64":
        arg(0); arg(1); body.byte(node.type === "U64" ? 0x42 : 0x41)
          .signed(-1n, node.type === "U64" ? 64 : 32)
          .byte(node.type === "U64" ? 0x85 : 0x73).byte(node.type === "U64" ? 0x83 : 0x71);
        break;
      case "Not32": case "Not64":
        arg(0); body.byte(node.type === "U64" ? 0x42 : 0x41)
          .signed(-1n, node.type === "U64" ? 64 : 32).byte(node.type === "U64" ? 0x85 : 0x73); break;
      case "LeastSignificantWord": arg(0); body.byte(0xa7); break;
      case "LeastSignificantHalf": arg(0); constant(0xffff).byte(0x71); break;
      case "LeastSignificantByte": arg(0); constant(255).byte(0x71); break;
      case "MostSignificantWord": arg(0); body.byte(0x42).signed(32n, 64).byte(0x88).byte(0xa7); break;
      case "MostSignificantBit": arg(0); constant(31).byte(0x76); break;
      case "IsZero32": arg(0); body.byte(0x45); break;
      case "IsZero64": arg(0); body.byte(0x50); break;
      case "CountLeadingZeros32": arg(0); body.byte(0x67); break;
      case "ByteReverseHalf":
        arg(0); constant(255).byte(0x71); constant(8).byte(0x74);
        arg(0); constant(8).byte(0x76); constant(255).byte(0x71).byte(0x72); break;
      case "ByteReverseWord":
        for (let byte = 0; byte < 4; ++byte) {
          arg(0); constant(byte * 8).byte(0x76); constant(255).byte(0x71);
          constant((3 - byte) * 8).byte(0x74);
          if (byte > 0) body.byte(0x72);
        }
        break;
      case "ZeroExtendWordToLong": case "ZeroExtendByteToLong": case "ZeroExtendHalfToLong": arg(0); body.byte(0xad); break;
      case "SignExtendWordToLong": arg(0); body.byte(0xac); break;
      case "SignExtendByteToLong": arg(0); body.byte(0xc0).byte(0xac); break;
      case "SignExtendHalfToLong": arg(0); body.byte(0xc1).byte(0xac); break;
      case "SignExtendByteToWord": arg(0); body.byte(0xc0); break;
      case "SignExtendHalfToWord": arg(0); body.byte(0xc1); break;
      case "ZeroExtendByteToWord": arg(0); constant(255).byte(0x71); break;
      case "ZeroExtendHalfToWord": arg(0); constant(0xffff).byte(0x71); break;
      case "Pack2x32To1x64":
        arg(0); body.byte(0xad); arg(1); body.byte(0xad).byte(0x42).signed(32n, 64).byte(0x86).byte(0x84); break;
      case "ConditionalSelect32": case "ConditionalSelect64": case "ConditionalSelectNZCV":
        arg(1); arg(2); condition(immediate(node.args[0]!)); body.byte(0x1b); break;
      default: {
        helper(node.op, node.args.map(argType), result ? [wasmType(node.type)] : [], () => node.args.forEach(argument));
      }
    }
    if (result) set(index + 2);
  });
  terminal(block.terminal);
  consume(block.cycles);
  return regionModule({ imports, shared: options.shared, maximumPages: options.maximumPages,
    signature: { params: ["i32", "i64"], results: ["i64"] }, locals, body });
}
