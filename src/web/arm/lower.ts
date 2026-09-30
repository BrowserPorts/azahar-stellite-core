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
  memory?: MemoryOptions;
}

export interface MemoryOptions {
  pageTable: number;
  fastmem?: number;
  pointerMaskBits: number;
  absoluteOffset: boolean;
  detectMisaligned: number;
  boundaryOnly: boolean;
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
  const memoryPointer = locals.length + 2;
  if (options.memory) locals.push("i32");
  const constant = (value: number): Bytes => body.byte(0x41).signed(BigInt(value), 32);
  const get = (index: number): Bytes => body.byte(0x20).u32(index);
  const set = (index: number): Bytes => body.byte(0x21).u32(index);
  const simd = (opcode: number): Bytes => body.byte(0xfd).u32(opcode);
  const zeroVector = (): Bytes => simd(0x0c).append(new Uint8Array(16));
  const vector64 = (emit: () => unknown): undefined => {
    zeroVector(); emit(); simd(0x1e).byte(0);
    return undefined;
  };
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
  const memoryAccess = (node: ArmBlock["nodes"][number]): undefined => {
    const config = options.memory;
    const read = node.op.startsWith("A32Read");
    const bits = Number(node.op.match(/\d+$/)![0]);
    const width = bits / 8;
    const fallback = (): undefined => helper(node.op, node.args.map(argType), read ? [wasmType(node.type)] : [],
      () => node.args.forEach(argument));
    // Ordered accesses stay in the core; NORMAL (0) is the ordinary RAM path.
    if (!config || (!config.pageTable && config.fastmem === undefined) ||
      immediate(node.args[read ? 2 : 3]!) !== 0) return fallback();
    const address = (): undefined => argument(node.args[1]!);
    const direct = (): undefined => {
      get(memoryPointer);
      if (!read) argument(node.args[2]!);
      const opcode = read ? { 8: 0x2d, 16: 0x2f, 32: 0x28, 64: 0x29 }[bits] :
        { 8: 0x3a, 16: 0x3b, 32: 0x36, 64: 0x37 }[bits];
      body.byte(opcode!).u32(0).u32(0);
      return undefined;
    };
    const branch = (): undefined => {
      body.byte(0x04).byte(read ? bits === 64 ? 0x7e : 0x7f : 0x40);
      direct(); body.byte(0x05); fallback(); body.byte(0x0b);
      return undefined;
    };
    if (config.fastmem !== undefined) {
      constant(config.fastmem); address(); body.byte(0x6a); set(memoryPointer);
      // Check the full address before wrapping it to wasm32, including the access width.
      body.byte(0x42).signed(BigInt(config.fastmem + width), 64);
      address(); body.byte(0xad).byte(0x7c);
      body.byte(0x3f).byte(0).byte(0xad).byte(0x42).signed(16n, 64).byte(0x86).byte(0x58);
      branch();
    } else {
      constant(config.pageTable); address(); constant(12).byte(0x76); constant(2).byte(0x74).byte(0x6a);
      body.byte(0x28).u32(2).u32(0);
      if (config.pointerMaskBits) constant(-1 << config.pointerMaskBits).byte(0x71);
      set(memoryPointer);
      get(memoryPointer).byte(0x45).byte(0x45);
      if (width > 1) {
        address(); constant(4095).byte(0x71); constant(4096 - width).byte(0x4d).byte(0x71);
        if ((config.detectMisaligned & bits) && !config.boundaryOnly) {
          address(); constant(width - 1).byte(0x71).byte(0x45).byte(0x71);
        }
      }
      get(memoryPointer); address();
      if (!config.absoluteOffset) constant(4095).byte(0x71);
      body.byte(0x6a); set(memoryPointer);
      branch();
    }
    return undefined;
  };
  const carry = (reference: number): undefined => {
    const wide = wideLocals.get(reference);
    const shift = carryLocals.get(reference);
    if (wide !== undefined) get(wide).byte(0x42).signed(32n, 64).byte(0x88).byte(0xa7);
    else if (shift !== undefined) get(shift);
    else if (block.nodes[reference]?.op === "MostSignificantWord") {
      argument(block.nodes[reference]!.args[0]!);
      body.byte(0x42).signed(31n, 64).byte(0x88).byte(0xa7); constant(1).byte(0x71);
    } else throw new JitError("compile", `Missing carry lowering for ${block.nodes[reference]?.op}`);
    return undefined;
  };
  const packed16 = (node: ArmBlock["nodes"][number], flags = false): undefined => {
    const match = /^Packed(Halving)?(AddSub|SubAdd|Add|Sub)(S|U)16$/.exec(node.op);
    if (!match) throw new JitError("compile", `Missing packed flags lowering for ${node.op}`);
    const halving = Boolean(match[1]);
    const signed = match[3] === "S";
    const cross = match[2] === "AddSub" || match[2] === "SubAdd";
    const lane = (position: number, half: number): undefined => {
      argument(node.args[position]!); constant(half * 16).byte(0x76);
      if (signed) body.byte(0xc1); else constant(65535).byte(0x71);
      return undefined;
    };
    for (let half = 0; half < 2; ++half) {
      const subtract = match[2] === "Sub" || match[2] === (half === 0 ? "AddSub" : "SubAdd");
      lane(0, half); lane(1, cross ? 1 - half : half); body.byte(subtract ? 0x6b : 0x6a);
      if (flags) {
        if (halving) throw new JitError("compile", "Halving packed operations do not produce GE flags");
        constant(signed || subtract ? 0 : 65536).byte(signed || subtract ? 0x4e : 0x4f);
        constant(-1).byte(0x6c);
      } else if (halving) {
        if (!signed) constant(0x1ffff).byte(0x71);
        constant(1).byte(signed ? 0x75 : 0x76);
      }
      constant(65535).byte(0x71); constant(half * 16).byte(0x74);
      if (half) body.byte(0x72);
    }
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
    if (/^Packed(Halving)?(AddSub|SubAdd|Add|Sub)(S|U)16$/.test(node.op)) packed16(node);
    else if (binary[node.op] !== undefined) {
      arg(0); arg(1); body.byte(binary[node.op]!);
    } else switch (node.op) {
      case "Void": case "PushRSB": case "A32UpdateUpperLocationDescriptor": result = false; break;
      case "Identity": arg(0); break;
      case "A32ReadMemory8": case "A32ReadMemory16": case "A32ReadMemory32": case "A32ReadMemory64":
      case "A32WriteMemory8": case "A32WriteMemory16": case "A32WriteMemory32": case "A32WriteMemory64":
        memoryAccess(node); break;
      case "FPAbs32": case "FPNeg32":
        arg(0); constant(node.op === "FPAbs32" ? 0x7fffffff : 0x80000000);
        body.byte(node.op === "FPAbs32" ? 0x71 : 0x73); break;
      case "FPAbs64": case "FPNeg64":
        arg(0); body.byte(0x42).signed(node.op === "FPAbs64" ? 0x7fffffffffffffffn : 0x8000000000000000n, 64);
        body.byte(node.op === "FPAbs64" ? 0x83 : 0x85); break;
      case "A32GetRegister": load(options.layout.registers + immediate(node.args[0]!) * 4); break;
      case "A32SetRegister": store(options.layout.registers + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister32": load(options.layout.extendedRegisters + immediate(node.args[0]!) * 4); break;
      case "A32SetExtendedRegister32": store(options.layout.extendedRegisters + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister64": load(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, true); break;
      case "A32SetExtendedRegister64": store(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, () => arg(1), true); break;
      case "ZeroVector": zeroVector(); break;
      case "A32GetVector": {
        const register = immediate(node.args[0]!);
        if (register < 64) vector64(() => load(options.layout.extendedRegisters + (register - 32) * 8, true));
        else { get(0); simd(0).u32(4).u32(options.layout.extendedRegisters + (register - 64) * 16); }
        break;
      }
      case "A32SetVector": {
        const register = immediate(node.args[0]!);
        if (register < 64) store(options.layout.extendedRegisters + (register - 32) * 8, () => {
          arg(1); simd(0x1d).byte(0);
        }, true);
        else { get(0); arg(1); simd(0x0b).u32(4).u32(options.layout.extendedRegisters + (register - 64) * 16); }
        break;
      }
      case "VectorTable": result = false; break;
      case "VectorTableLookup64": {
        const tableArgument = node.args[1]!;
        const table = "ref" in tableArgument ? block.nodes[tableArgument.ref] : undefined;
        if (table?.op !== "VectorTable") throw new JitError("compile", "Invalid ARM vector table");
        const entries = table.args.filter((entry) => !("imm" in entry && entry.type === "Void"));
        if (entries.length < 1 || entries.length > 4 || entries.some((entry) => argType(entry) !== "i64")) {
          throw new JitError("compile", "Invalid ARM vector table width");
        }
        const pair = (start: number): undefined => {
          vector64(() => argument(entries[start]!));
          if (entries[start + 1]) { argument(entries[start + 1]!); simd(0x1e).byte(1); }
          return undefined;
        };
        vector64(() => arg(0));
        pair(0); vector64(() => arg(2)); simd(0x0e);
        if (entries.length > 2) {
          pair(2); vector64(() => arg(2)); constant(16); simd(0x0f); simd(0x71); simd(0x0e); simd(0x50);
        }
        vector64(() => arg(2)); constant(entries.length * 8); simd(0x0f); simd(0x2c);
        simd(0x52); simd(0x1d).byte(0);
        break;
      }
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
      case "A32SetGEFlagsCompressed": mergeFlags(0x000f0000, () => { arg(0); constant(16).byte(0x74); }); break;
      case "A32SetGEFlags": mergeFlags(0x000f0000, () => {
        for (let flag = 0; flag < 4; ++flag) {
          arg(0); constant(flag * 8).byte(0x76); constant(1).byte(0x71); constant(flag + 16).byte(0x74);
          if (flag) body.byte(0x72);
        }
      }); break;
      case "A32GetGEFlags":
        for (let flag = 0; flag < 4; ++flag) {
          load(options.layout.cpsr); constant(flag + 16).byte(0x76); constant(1).byte(0x71);
          constant(255).byte(0x6c); constant(flag * 8).byte(0x74);
          if (flag) body.byte(0x72);
        }
        break;
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
      case "GetGEFromOp": packed16(block.nodes[(node.args[0] as { ref: number }).ref]!, true); break;
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
      case "Add64": case "Sub64":
        arg(0); arg(1);
        if (node.op === "Sub64") body.byte(0x42).signed(-1n, 64).byte(0x85);
        body.byte(0x7c); arg(2); body.byte(0xad).byte(0x7c); break;
      case "SignedDiv32": case "UnsignedDiv32":
        arg(1); body.byte(0x45).byte(0x04).byte(0x7f); constant(0); body.byte(0x05);
        if (node.op === "SignedDiv32") {
          arg(0); constant(-2147483648).byte(0x46); arg(1); constant(-1).byte(0x46).byte(0x71);
          body.byte(0x04).byte(0x7f); constant(-2147483648); body.byte(0x05);
        }
        arg(0); arg(1); body.byte(node.op === "SignedDiv32" ? 0x6d : 0x6e);
        if (node.op === "SignedDiv32") body.byte(0x0b);
        body.byte(0x0b); break;
      case "PackedAbsDiffSumU8":
        for (let byte = 0; byte < 4; ++byte) {
          const lane = (position: number): undefined => {
            arg(position); constant(byte * 8).byte(0x76); constant(255).byte(0x71);
            return undefined;
          };
          lane(0); lane(1); body.byte(0x6b);
          lane(1); lane(0); body.byte(0x6b);
          lane(0); lane(1); body.byte(0x4f).byte(0x1b);
          if (byte) body.byte(0x6a);
        }
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
