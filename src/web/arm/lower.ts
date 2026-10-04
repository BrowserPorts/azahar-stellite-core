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
const vectorBinary: Record<string, number> = {
  VectorAnd: 0x4e, VectorAndNot: 0x4f, VectorOr: 0x50, VectorEor: 0x51,
  VectorAdd8: 0x6e, VectorAdd16: 0x8e, VectorAdd32: 0xae, VectorAdd64: 0xce,
  VectorSub8: 0x71, VectorSub16: 0x91, VectorSub32: 0xb1, VectorSub64: 0xd1,
  VectorMultiply16: 0x95, VectorMultiply32: 0xb5, VectorMultiply64: 0xd5,
  VectorMultiplySignedWiden8: 0x9c, VectorMultiplySignedWiden16: 0xbc, VectorMultiplySignedWiden32: 0xdc,
  VectorMultiplyUnsignedWiden8: 0x9e, VectorMultiplyUnsignedWiden16: 0xbe, VectorMultiplyUnsignedWiden32: 0xde,
  VectorEqual8: 0x23, VectorEqual16: 0x2d, VectorEqual32: 0x37, VectorEqual64: 0xd6,
  VectorGreaterS8: 0x27, VectorGreaterS16: 0x31, VectorGreaterS32: 0x3b, VectorGreaterS64: 0xd9,
  VectorMinS8: 0x76, VectorMinU8: 0x77, VectorMaxS8: 0x78, VectorMaxU8: 0x79,
  VectorMinS16: 0x96, VectorMinU16: 0x97, VectorMaxS16: 0x98, VectorMaxU16: 0x99,
  VectorMinS32: 0xb6, VectorMinU32: 0xb7, VectorMaxS32: 0xb8, VectorMaxU32: 0xb9,
};
const vectorUnary: Record<string, number> = {
  VectorSignExtend8: 0x87, VectorSignExtend16: 0xa7, VectorSignExtend32: 0xc7,
  VectorZeroExtend8: 0x89, VectorZeroExtend16: 0xa9, VectorZeroExtend32: 0xc9,
  VectorAbs8: 0x60, VectorAbs16: 0x80, VectorAbs32: 0xa0, VectorAbs64: 0xc0,
  VectorPopulationCount: 0x62,
};
const vectorShiftLeft: Record<number, number> = { 8: 0x6b, 16: 0x8b, 32: 0xab, 64: 0xcb };
const laneExtract: Record<number, number> = { 8: 0x16, 16: 0x19, 32: 0x1b, 64: 0x1d };
const laneReplace: Record<number, number> = { 8: 0x17, 16: 0x1a, 32: 0x1c, 64: 0x1e };
const laneSplat: Record<number, number> = { 8: 0x0f, 16: 0x10, 32: 0x11, 64: 0x12 };

function wasmType(type: string): ValueType {
  return type === "U64" || type === "CoprocInfo" ? "i64" : type === "U128" ? "v128" : "i32";
}

export interface LowerOptions {
  layout: ArmLayout;
  execution?: ArmExecutionLayout;
  shared: boolean;
  maximumPages: number;
  /** Explicit arithmetic/peripheral helpers exported as raw Wasm functions by the core. */
  helperNames?: ReadonlySet<string>;
  memory?: MemoryOptions;
}

export interface ArmExecutionLayout {
  halt: number;
  clock: number;
  budget: number;
  pendingTicks: number;
  sourceUsed: number;
  minimumBudget: number;
  /** Absolute counter address, or zero when execution counting is disabled. */
  completedBlocks: number;
  fastDispatch: {
    pointer: number;
    mask: number;
    strideShift: number;
    location: number;
    slot: number;
    minimumBudget: number;
    hits: number;
  };
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
  if (Boolean(block.sourceCell) !== Boolean(options.execution)) {
    throw new JitError("compile", "ARM execution layout does not match the region");
  }
  const body = new Bytes();
  const imports: FunctionImport[] = [];
  const hasBxWritePc = block.nodes.some((node) => node.op === "A32BXWritePC");
  const locals: ValueType[] = block.nodes.map((node) => wasmType(node.type));
  const carryLocals = new Map<number, number>();
  const wideLocals = new Map<number, number>();
  const overflowLocals = new Map<number, number>();
  block.nodes.forEach((node, index) => {
    if (["Add32", "Sub32"].includes(node.op)) {
      wideLocals.set(index, locals.length + 2);
      locals.push("i64");
    } else if (["SignedSaturatedAddWithFlag32", "SignedSaturatedSubWithFlag32"].includes(node.op)) {
      overflowLocals.set(index, locals.length + 2);
      locals.push("i32");
    } else if (["LogicalShiftLeft32", "LogicalShiftRight32", "ArithmeticShiftRight32", "RotateRight32", "RotateRightExtended"].includes(node.op)) {
      carryLocals.set(index, locals.length + 2);
      locals.push("i32");
    }
  });
  const memoryPointer = locals.length + 2;
  if (options.memory) locals.push("i32");
  const scalarShiftCount = locals.length + 2;
  if (block.nodes.some((node) => /^Vector((Arithmetic|Logical)VShift|RoundingShiftLeft(S|U))(32|64)$/.test(node.op))) {
    locals.push("i32", "i32");
  }
  const vectorShiftScratch = locals.length + 2;
  if (block.nodes.some((node) => /^Vector((Arithmetic|Logical)VShift|RoundingShiftLeft(S|U))(8|16)$/.test(node.op))) {
    locals.push("v128", "v128", "v128", "v128", "v128");
    if (block.nodes.some((node) => /^VectorRoundingShiftLeft(S|U)(8|16)$/.test(node.op))) locals.push("v128");
  }
  const linkSlot = locals.length + 2;
  const clockPointer = linkSlot + 1;
  const blockClock = linkSlot + 2;
  if (block.sourceCell) locals.push("i32", "i32", "i64");
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
  const checkHalt = (): undefined => {
    if (options.execution) {
      load(options.execution.halt);
      if (options.shared) body.byte(0xfe).u32(0x10).u32(2).u32(0);
      else body.byte(0x28).u32(2).u32(0);
    } else helper("WasmCheckHalt", [], ["i32"], () => undefined);
    return undefined;
  };
  const incrementCounter = (address: number): undefined => {
    if (!address) return undefined;
    constant(address);
    if (options.shared) {
      body.byte(0x42).signed(1n, 64).byte(0xfe).u32(0x1f).u32(3).u32(0).byte(0x1a);
    } else {
      constant(address).byte(0x29).u32(3).u32(0);
      body.byte(0x42).signed(1n, 64).byte(0x7c).byte(0x37).u32(3).u32(0);
    }
    return undefined;
  };
  const chargeTicks = (cycles: number): undefined => {
    const execution = options.execution!;
    // Size-based eviction runs between native entries; linked blocks share their timestamp.
    constant(block.sourceCell!);
    load(execution.clock).byte(0x29).u32(3).u32(0);
    body.byte(0x37).u32(3).u32(execution.sourceUsed);
    store(execution.pendingTicks, () => {
      load(execution.pendingTicks, true);
      body.byte(0x42).signed(BigInt(cycles), 64).byte(0x7c);
    }, true);
    // Linked regions carry the remaining budget in their i64 parameter.
    get(1).byte(0x42).signed(BigInt(cycles), 64).byte(0x56).byte(0x04).byte(0x7e);
    consume(cycles).byte(0x05).byte(0x42).signed(0n, 64).byte(0x0b); set(1);
    incrementCounter(execution.completedBlocks);
    return undefined;
  };
  const finishBlock = (cycles: number, destination?: Extract<Terminal, { kind: "link" }>,
    fastDispatch = false): undefined => {
    if (!block.sourceCell) {
      consume(cycles).byte(0x0f);
      return undefined;
    }
    chargeTicks(cycles);
    const canLink = (cell: number, minimum: bigint): undefined => {
      const execution = options.execution!;
      checkHalt(); body.byte(0x04).byte(0x40);
      body.byte(0x42).signed(0n, 64); set(1); body.byte(0x0b);
      get(1);
      if (cell) constant(cell).byte(0x28).u32(2).u32(execution.minimumBudget).byte(0xad);
      else body.byte(0x42).signed(minimum, 64);
      // A smaller budget returns to native dispatch without discarding the unused ticks.
      body.byte(0x5a);
      get(1).byte(0x42).signed(0n, 64).byte(0x55).byte(0x71);
      return undefined;
    };
    const tailCall = (): undefined => {
      get(0); get(1); get(linkSlot);
      body.byte(0x13).u32(0).byte(0);
      return undefined;
    };
    if (destination?.cell && destination.fpscr !== undefined) {
      canLink(destination.cell, 0n); body.byte(0x04).byte(0x40);
      // Static terminals just wrote PC and CPSR mode bits; FPSCR can change within the block.
      load(options.layout.fpscr); constant(0x07f70000).byte(0x71);
      constant(destination.fpscr & 0x07f70000).byte(0x46);
      constant(destination.cell).byte(0x28).u32(2).u32(0).byte(0x22).u32(linkSlot);
      body.byte(0x45).byte(0x45).byte(0x71).byte(0x04).byte(0x40);
      tailCall(); body.byte(0x0b).byte(0x0b);
    } else if (fastDispatch) {
      canLink(0, 1n); body.byte(0x04).byte(0x40);
      const cache = options.execution!.fastDispatch;
      // Match Dynarmic's LocationDescriptor, including split Thumb IT-state bits.
      load(options.layout.cpsr); set(clockPointer);
      load(options.layout.fpscr); constant(0x07f70000).byte(0x71);
      get(clockPointer); constant(5).byte(0x76); constant(1).byte(0x71).byte(0x72);
      get(clockPointer); constant(8).byte(0x76); constant(2).byte(0x71).byte(0x72);
      get(clockPointer); constant(0xfc00).byte(0x71).byte(0x72);
      get(clockPointer); constant(17).byte(0x76); constant(0x300).byte(0x71).byte(0x72);
      body.byte(0xad).byte(0x42).signed(32n, 64).byte(0x86);
      load(options.layout.registers + 60).byte(0xad).byte(0x84); set(blockClock);
      load(cache.pointer);
      get(blockClock).byte(0x42).signed(1n, 64).byte(0x88);
      get(blockClock).byte(0x42).signed(32n, 64).byte(0x88).byte(0x85).byte(0xa7);
      constant(cache.mask).byte(0x71); constant(cache.strideShift).byte(0x74).byte(0x6a); set(clockPointer);
      get(clockPointer).byte(0x29).u32(3).u32(cache.location); get(blockClock).byte(0x51);
      get(1); get(clockPointer).byte(0x28).u32(2).u32(cache.minimumBudget).byte(0xad).byte(0x5a).byte(0x71);
      get(clockPointer).byte(0x28).u32(2).u32(cache.slot).byte(0x22).u32(linkSlot);
      body.byte(0x45).byte(0x45).byte(0x71);
      checkHalt(); body.byte(0x45).byte(0x71).byte(0x04).byte(0x40);
      incrementCounter(cache.hits);
      tailCall(); body.byte(0x0b).byte(0x0b);
    }
    store(options.execution!.budget, () => get(1), true);
    body.byte(0x42).signed(0n, 64).byte(0x0f);
    return undefined;
  };
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
  const packed = (node: ArmBlock["nodes"][number], flags = false): undefined => {
    const match = /^Packed(Halving|Saturated)?(AddSub|SubAdd|Add|Sub)(S|U)(8|16)$/.exec(node.op);
    if (!match) throw new JitError("compile", `Missing packed flags lowering for ${node.op}`);
    const halving = match[1] === "Halving";
    const saturated = match[1] === "Saturated";
    const signed = match[3] === "S";
    const bits = Number(match[4]);
    const mask = 2 ** bits - 1;
    const cross = match[2] === "AddSub" || match[2] === "SubAdd";
    if (!flags && !halving && !cross) {
      argument(node.args[0]!); simd(0x11);
      argument(node.args[1]!); simd(0x11);
      const subtract = match[2] === "Sub";
      simd((bits === 8 ? 0x6e : 0x8e) + (subtract ? 3 : 0) +
        (saturated ? signed ? 1 : 2 : 0));
      simd(0x1b).byte(0);
      return undefined;
    }
    const lane = (position: number, half: number): undefined => {
      argument(node.args[position]!); constant(half * bits).byte(0x76);
      if (signed) body.byte(bits === 8 ? 0xc0 : 0xc1); else constant(mask).byte(0x71);
      return undefined;
    };
    for (let half = 0; half < 32 / bits; ++half) {
      const subtract = match[2] === "Sub" || match[2] === (half === 0 ? "AddSub" : "SubAdd");
      lane(0, half); lane(1, cross ? 1 - half : half); body.byte(subtract ? 0x6b : 0x6a);
      if (flags) {
        if (halving || saturated) throw new JitError("compile", "This packed operation does not produce GE flags");
        constant(signed || subtract ? 0 : 2 ** bits).byte(signed || subtract ? 0x4e : 0x4f);
        constant(-1).byte(0x6c);
      } else if (halving) {
        if (!signed) constant(2 ** (bits + 1) - 1).byte(0x71);
        constant(1).byte(signed ? 0x75 : 0x76);
      }
      constant(mask).byte(0x71); constant(half * bits).byte(0x74);
      if (half) body.byte(0x72);
    }
    return undefined;
  };
  const overflow = (reference: number): undefined => {
    const source = block.nodes[reference]!;
    const saturatedOverflow = overflowLocals.get(reference);
    if (saturatedOverflow !== undefined) {
      get(saturatedOverflow);
      return undefined;
    }
    if (source.op === "SignedSaturation" || source.op === "UnsignedSaturation") {
      argument(source.args[0]!); get(reference + 2).byte(0x47);
      return undefined;
    }
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
        finishBlock(block.cycles, term);
        break;
      case "dispatch": finishBlock(block.cycles); break;
      case "fast-dispatch": finishBlock(block.cycles, undefined, true); break;
      case "if":
        condition(term.condition); body.byte(0x04).byte(0x40);
        terminal(term.then); body.byte(0x05); terminal(term.else); body.byte(0x0b);
        break;
      case "check-bit":
        load(options.layout.checkBit); body.byte(0x04).byte(0x40);
        terminal(term.then); body.byte(0x05); terminal(term.else); body.byte(0x0b);
        break;
      case "check-halt":
        checkHalt();
        body.byte(0x45).byte(0x04).byte(0x40);
        terminal(term.else); body.byte(0x0b);
        finishBlock(block.cycles);
        break;
    }
    return undefined;
  };
  get(1).byte(0x42).signed(0n, 64).byte(0x57).byte(0x04).byte(0x40);
  get(1).byte(0x0f).byte(0x0b);
  if (block.condition !== 14) {
    if (block.conditionFailedPc === undefined || block.conditionFailedCpsr === undefined ||
      block.conditionFailedCycles === undefined) {
      throw new JitError("compile", "Conditional ARM block is missing its failure location");
    }
    condition(block.condition); body.byte(0x45).byte(0x04).byte(0x40);
    store(options.layout.registers + 60, () => constant(block.conditionFailedPc!));
    mergeFlags(0x0600fe20, () => constant(block.conditionFailedCpsr!));
    finishBlock(block.conditionFailedCycles, {
      kind: "link", pc: block.conditionFailedPc, cpsr: block.conditionFailedCpsr,
      ...(block.conditionFailedCell ? { cell: block.conditionFailedCell } : {}),
      ...(block.conditionFailedFpscr !== undefined ? { fpscr: block.conditionFailedFpscr } : {}),
    });
    body.byte(0x0b);
  }
  block.nodes.forEach((node, index) => {
    const arg = (position: number): undefined => argument(node.args[position]!);
    let result = node.type !== "Void";
    const rearrangement = /^Vector(Interleave(Lower|Upper)|Deinterleave(Even|Odd)(Lower)?)(8|16|32|64)$/.exec(node.op);
    const vectorShift = /^Vector(ArithmeticShiftRight|LogicalShiftLeft|LogicalShiftRight)(8|16|32|64)$/.exec(node.op);
    const variableShift = /^Vector(Arithmetic|Logical)VShift(8|16|32|64)$/.exec(node.op);
    const roundingShift = /^VectorRoundingShiftLeft(S|U)(8|16|32|64)$/.exec(node.op);
    const halving = /^Vector(Rounding)?Halving(Add|Sub)(S|U)(8|16|32)$/.exec(node.op);
    const vectorSign = /^FPVector(Abs|Neg)(16|32|64)$/.exec(node.op);
    const paired = /^(FP)?VectorPairedAdd(Lower)?(8|16|32|64)$/.exec(node.op);
    const pairedWiden = /^VectorPairedAdd(Signed|Unsigned)Widen(8|16|32)$/.exec(node.op);
    const reversedElements = /^VectorReverseElementsIn(Half|Word|Long)Groups(8|16|32)$/.exec(node.op);
    const leadingZeros = /^VectorCountLeadingZeros(8|16|32)$/.exec(node.op);
    const doublingHigh = /^VectorSignedSaturatedDoublingMultiplyHigh(Rounding)?(16|32)$/.exec(node.op);
    const doublingLong = /^VectorSignedSaturatedDoublingMultiplyLong(16|32)$/.exec(node.op);
    const saturatedNarrow = /^Vector(SignedSaturatedNarrowTo(Signed|Unsigned)|UnsignedSaturatedNarrow)(16|32|64)$/.exec(node.op);
    const saturatedBinary = /^Vector(Signed|Unsigned)Saturated(Add|Sub)(8|16|32|64)$/.exec(node.op);
    const saturatedUnary = /^VectorSignedSaturated(Abs|Neg)(8|16|32|64)$/.exec(node.op);
    const absoluteDifference = /^Vector(Signed|Unsigned)AbsoluteDifference(8|16|32)$/.exec(node.op);
    if (/^Packed(Halving|Saturated)?(AddSub|SubAdd|Add|Sub)(S|U)(8|16)$/.test(node.op)) packed(node);
    else if (rearrangement) {
      const elementBytes = Number(rearrangement[5]) / 8;
      const interleave = rearrangement[2] !== undefined;
      const lower = rearrangement[4] !== undefined;
      const width = lower ? 8 : 16;
      if (lower && elementBytes === 8) throw new JitError("compile", "Invalid ARM deinterleave width");
      arg(0); arg(1); simd(0x0d);
      for (let byte = 0; byte < 16; ++byte) {
        const element = Math.floor(byte / elementBytes);
        const within = byte % elementBytes;
        if (interleave) {
          body.byte((element % 2) * 16 + Math.floor(element / 2) * elementBytes + within +
            (rearrangement[2] === "Upper" ? 8 : 0));
        } else {
          const half = width / elementBytes / 2;
          const source = (element >= half ? 16 : 0) +
            ((element % half) * 2 + (rearrangement[3] === "Odd" ? 1 : 0)) * elementBytes + within;
          body.byte(lower && byte >= 8 ? 0 : source);
        }
      }
      if (lower) { body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); }
    } else if (reversedElements) {
      const groupBytes = { Half: 2, Word: 4, Long: 8 }[reversedElements[1] as "Half" | "Word" | "Long"];
      const elementBytes = Number(reversedElements[2]) / 8;
      if (elementBytes >= groupBytes) throw new JitError("compile", "Invalid ARM element reversal width");
      arg(0); arg(0); simd(0x0d);
      for (let byte = 0; byte < 16; ++byte) body.byte(byte ^ (groupBytes - elementBytes));
    } else if (leadingZeros) {
      const bits = Number(leadingZeros[1]);
      if (bits === 32) {
        zeroVector();
        for (let lane = 0; lane < 4; ++lane) {
          arg(0); simd(0x1b).byte(lane); body.byte(0x67); simd(0x1c).byte(lane);
        }
      } else {
        arg(0); set(index + 2);
        for (let shift = 1; shift < bits; shift *= 2) {
          get(index + 2); get(index + 2); constant(shift);
          simd(vectorShiftLeft[bits]! + 2); simd(0x50); set(index + 2);
        }
        constant(bits); simd(laneSplat[bits]!); get(index + 2); simd(0x62);
        if (bits === 16) simd(0x7d);
        simd(vectorBinary[`VectorSub${bits}`]!);
      }
    } else if (doublingLong) {
      const bits = Number(doublingLong[1]);
      arg(0); arg(1); simd(bits === 16 ? 0xbc : 0xdc);
      constant(1); simd(vectorShiftLeft[bits * 2]!); body.byte(0x22).u32(index + 2);
      get(index + 2);
      if (bits === 16) constant(-0x80000000); else body.byte(0x42).signed(-0x8000000000000000n, 64);
      simd(laneSplat[bits * 2]!); simd(vectorBinary[`VectorEqual${bits * 2}`]!);
      body.byte(0x22).u32(index + 2); simd(0x51);
      store(options.layout.fpscr, () => {
        load(options.layout.fpscr); get(index + 2); simd(0x53); constant(27).byte(0x74).byte(0x72);
      });
    } else if (doublingHigh) {
      const bits = Number(doublingHigh[2]);
      const rounding = doublingHigh[1] !== undefined;
      const splat = (value: number): Bytes => constant(value).byte(0xfd).u32(laneSplat[bits]!);
      arg(0); splat(-(2 ** (bits - 1))); simd(vectorBinary[`VectorEqual${bits}`]!);
      arg(1); splat(-(2 ** (bits - 1))); simd(vectorBinary[`VectorEqual${bits}`]!);
      simd(0x4e); set(index + 2);
      if (bits === 16 && rounding) { arg(0); arg(1); simd(0x82); }
      else {
        for (let part = 0; part < 2; ++part) {
          arg(0); arg(1); simd((bits === 16 ? 0xbc : 0xdc) + part);
          if (rounding) {
            body.byte(0x42).signed(0x40000000n, 64); simd(0x12); simd(0xce);
          }
          constant(bits - 1); simd(vectorShiftLeft[bits * 2]! + 1);
        }
        if (bits === 16) simd(0x85);
        else {
          simd(0x0d);
          for (let byte = 0; byte < 16; ++byte) body.byte(Math.floor(byte / 4) * 8 + byte % 4);
          splat(0x7fffffff); get(index + 2); simd(0x4d); simd(0x52);
        }
      }
      store(options.layout.fpscr, () => {
        load(options.layout.fpscr); get(index + 2); simd(0x53); constant(27).byte(0x74).byte(0x72);
      });
    } else if (variableShift || roundingShift) {
      const bits = Number((variableShift ?? roundingShift)![2]);
      const arithmetic = variableShift?.[1] === "Arithmetic" || roundingShift?.[1] === "S";
      if (bits <= 16) {
        const left = vectorShiftScratch;
        const right = left + 1;
        const magnitude = left + 2;
        const negative = left + 3;
        const mask = left + 4;
        const before = left + 5;
        const splat = (value: number): Bytes => constant(value).byte(0xfd).u32(laneSplat[bits]!);
        const compare = bits === 8 ? 0x23 : 0x2d;
        const shift = vectorShiftLeft[bits]!;
        arg(0); set(left); arg(0); set(right);
        arg(1);
        // Every lane uses only its signed low byte as the shift count.
        if (bits === 16) { constant(8); simd(shift); constant(8); simd(shift + 1); }
        set(magnitude);
        get(magnitude); zeroVector(); simd(compare + 2); set(negative);
        get(magnitude); simd(bits === 8 ? 0x60 : 0x80); set(magnitude);
        if (roundingShift) {
          get(magnitude); splat(1); simd(vectorBinary[`VectorSub${bits}`]!); set(before);
        }
        // Parallel barrel shifts keep the byte and halfword lanes in SIMD registers.
        for (let amount = 1; amount < bits; amount *= 2) {
          get(magnitude); splat(amount); simd(0x4e); zeroVector(); simd(compare + 1); set(mask);
          get(left); constant(amount); simd(shift); get(left); get(mask); simd(0x52); set(left);
          if (roundingShift) {
            get(before); splat(amount); simd(0x4e); zeroVector(); simd(compare + 1); set(mask);
          }
          get(right); constant(amount); simd(shift + (arithmetic ? 1 : 2));
          get(right); get(mask); simd(0x52); set(right);
        }
        get(magnitude); splat(bits); simd(compare + 3); set(mask);
        get(left); get(mask); simd(0x4e); set(left);
        get(right);
        if (roundingShift) {
          // Split the discarded bit from the shifted value to avoid rounding overflow.
          constant(1); simd(shift + (arithmetic ? 1 : 2));
          get(right); splat(1); simd(0x4e); simd(vectorBinary[`VectorAdd${bits}`]!);
          get(magnitude); splat(bits + 1); simd(compare + 3); simd(0x4e);
        } else if (arithmetic) { arg(0); constant(bits - 1); simd(shift + 1); get(mask); simd(0x52); }
        else { get(mask); simd(0x4e); }
        get(left); get(negative); simd(0x52);
      } else {
        const magnitude = scalarShiftCount + 1;
        const wide = bits === 64;
        const zero = (): Bytes => wide ? body.byte(0x42).signed(0n, 64) : constant(0);
        const lane = (position: number): Bytes => {
          arg(0); return simd(laneExtract[bits]!).byte(position);
        };
        zeroVector();
        for (let position = 0; position < 128 / bits; ++position) {
          arg(1); simd(laneExtract[bits]!).byte(position);
          if (wide) body.byte(0xa7);
          body.byte(0xc0); set(scalarShiftCount);
          constant(0); get(scalarShiftCount).byte(0x6b); get(scalarShiftCount);
          get(scalarShiftCount); constant(0).byte(0x48).byte(0x1b); set(magnitude);
          lane(position); get(magnitude);
          if (wide) body.byte(0xad);
          body.byte(wide ? 0x86 : 0x74); zero();
          get(magnitude); constant(bits).byte(0x49).byte(0x1b);
          const rightOpcode = wide ? arithmetic ? 0x87 : 0x88 : arithmetic ? 0x75 : 0x76;
          if (roundingShift) {
            const shifted = (): undefined => {
              lane(position); get(magnitude); constant(1).byte(0x6b);
              if (wide) body.byte(0xad);
              body.byte(rightOpcode);
              return undefined;
            };
            shifted();
            if (wide) body.byte(0x42).signed(1n, 64); else constant(1);
            body.byte(rightOpcode);
            shifted();
            if (wide) body.byte(0x42).signed(1n, 64); else constant(1);
            body.byte(wide ? 0x83 : 0x71).byte(wide ? 0x7c : 0x6a);
            zero(); get(magnitude); constant(bits + 1).byte(0x49).byte(0x1b);
          } else {
            lane(position); get(magnitude);
            if (arithmetic) {
              constant(bits - 1); get(magnitude); constant(bits - 1).byte(0x49).byte(0x1b);
            }
            if (wide) body.byte(0xad);
            body.byte(rightOpcode);
            if (!arithmetic) { zero(); get(magnitude); constant(bits).byte(0x49).byte(0x1b); }
          }
          get(scalarShiftCount); constant(0).byte(0x4e).byte(0x1b);
          simd(laneReplace[bits]!).byte(position);
        }
      }
    } else if (halving) {
      const rounded = halving[1] !== undefined;
      const subtract = halving[2] === "Sub";
      const signed = halving[3] === "S";
      const bits = Number(halving[4]);
      if (rounded && !signed && bits <= 16) {
        arg(0); arg(1); simd(bits === 8 ? 0x7b : 0x9b);
      } else if (subtract) {
        arg(0); arg(1); simd(0x51); constant(1); simd(vectorShiftLeft[bits]! + (signed ? 1 : 2));
        arg(1); arg(0); simd(0x4f); simd(vectorBinary[`VectorSub${bits}`]!);
      } else {
        // These identities retain the carry without widening or overflowing a lane.
        arg(0); arg(1); simd(rounded ? 0x50 : 0x4e);
        arg(0); arg(1); simd(0x51); constant(1); simd(vectorShiftLeft[bits]! + (signed ? 1 : 2));
        simd(vectorBinary[`Vector${rounded ? "Sub" : "Add"}${bits}`]!);
      }
    } else if (saturatedNarrow) {
      const bits = Number(saturatedNarrow[3]);
      const signedInput = saturatedNarrow[1]!.startsWith("Signed");
      const signedOutput = saturatedNarrow[2] === "Signed";
      if (bits <= 32) {
        arg(0);
        if (!signedInput) {
          constant(2 ** (bits / 2) - 1); simd(laneSplat[bits]!);
          simd(vectorBinary[`VectorMinU${bits}`]!);
        }
        zeroVector(); simd((bits === 16 ? 0x65 : 0x85) + (signedOutput ? 0 : 1));
      } else {
        const bound = (value: bigint): Bytes => body.byte(0x42).signed(value, 64);
        const maximum = signedOutput ? 0x7fffffffn : 0xffffffffn;
        const minimum = signedOutput ? -0x80000000n : 0n;
        zeroVector();
        for (let lane = 0; lane < 2; ++lane) {
          const input = (): Bytes => { arg(0); return simd(0x1d).byte(lane); };
          bound(maximum);
          if (signedInput) {
            bound(minimum); input(); input(); bound(minimum).byte(0x53).byte(0x1b);
          } else input();
          input(); bound(maximum).byte(signedInput ? 0x55 : 0x56).byte(0x1b).byte(0xa7);
          simd(0x1c).byte(lane);
        }
      }
      body.byte(0x22).u32(index + 2);
      store(options.layout.fpscr, () => {
        load(options.layout.fpscr); arg(0); get(index + 2);
        simd(vectorUnary[`Vector${signedOutput ? "Sign" : "Zero"}Extend${bits / 2}`]!);
        simd(0x51); simd(0x53); constant(27).byte(0x74).byte(0x72);
      });
    } else if (saturatedUnary) {
      const bits = Number(saturatedUnary[2]);
      if (saturatedUnary[1] === "Abs") { arg(0); simd(vectorUnary[`VectorAbs${bits}`]!); }
      else { zeroVector(); arg(0); simd(vectorBinary[`VectorSub${bits}`]!); }
      arg(0);
      if (bits === 64) body.byte(0x42).signed(-0x8000000000000000n, 64);
      else constant(-(2 ** (bits - 1)));
      simd(laneSplat[bits]!); simd(vectorBinary[`VectorEqual${bits}`]!);
      body.byte(0x22).u32(index + 2); simd(0x51);
      store(options.layout.fpscr, () => {
        load(options.layout.fpscr); get(index + 2); simd(0x53); constant(27).byte(0x74).byte(0x72);
      });
    } else if (saturatedBinary) {
      const signed = saturatedBinary[1] === "Signed";
      const subtract = saturatedBinary[2] === "Sub";
      const bits = Number(saturatedBinary[3]);
      const wrapping = vectorBinary[`Vector${subtract ? "Sub" : "Add"}${bits}`]!;
      if (bits <= 16) {
        const opcode = (bits === 8 ? 0x6f : 0x8f) + (signed ? 0 : 1) + (subtract ? 3 : 0);
        arg(0); arg(1); simd(opcode); body.byte(0x22).u32(index + 2);
        store(options.layout.fpscr, () => {
          load(options.layout.fpscr); get(index + 2); arg(0); arg(1); simd(wrapping);
          simd(0x51); simd(0x53); constant(27).byte(0x74).byte(0x72);
        });
      } else {
        const splat = (value: bigint): Bytes => {
          if (bits === 32) constant(Number(value)); else body.byte(0x42).signed(value, 64);
          return simd(laneSplat[bits]!);
        };
        arg(0); arg(1); simd(wrapping); set(index + 2);
        if (signed) {
          arg(0); constant(bits - 1); simd(vectorShiftLeft[bits]! + 1);
          splat((1n << BigInt(bits - 1)) - 1n); simd(0x51);
        } else if (subtract) zeroVector();
        else splat(-1n);
        get(index + 2);
        if (signed) {
          arg(0); get(index + 2); simd(0x51); arg(0); arg(1); simd(0x51);
          simd(subtract ? 0x4e : 0x4f); constant(bits - 1); simd(vectorShiftLeft[bits]! + 1);
        } else {
          if (subtract) arg(1); else arg(0);
          if (bits === 64) { splat(-0x8000000000000000n); simd(0x51); }
          if (subtract) arg(0); else get(index + 2);
          if (bits === 64) { splat(-0x8000000000000000n); simd(0x51); }
          simd(bits === 32 ? 0x3c : 0xd9);
        }
        body.byte(0x22).u32(index + 2); simd(0x52);
        store(options.layout.fpscr, () => {
          load(options.layout.fpscr); get(index + 2); simd(0x53); constant(27).byte(0x74).byte(0x72);
        });
      }
    } else if (paired) {
      const bits = Number(paired[3]);
      const bytes = bits / 8;
      const lower = paired[2] !== undefined;
      const operand = (part: number): undefined => {
        arg(0); arg(1); simd(0x0d);
        const lanes = (lower ? 8 : 16) / bytes;
        for (let byte = 0; byte < 16; ++byte) {
          const lane = Math.floor(byte / bytes);
          const source = lower && bits === 64 ? part * 16 :
            (lane < lanes / 2 ? 0 : 16) + ((lane % (lanes / 2)) * 2 + part) * bytes;
          body.byte(lower && byte >= 8 ? 0 : source + byte % bytes);
        }
        if (lower) { body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); }
        return undefined;
      };
      if (paired[1]) {
        helper(`FPVectorAdd${bits}`, ["v128", "v128", "i32"], ["v128"], () => {
          operand(0); operand(1); arg(2);
        });
      } else { operand(0); operand(1); simd(vectorBinary[`VectorAdd${bits}`]!); }
      if (lower) { body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); }
    } else if (pairedWiden) {
      const bits = Number(pairedWiden[2]);
      const signed = pairedWiden[1] === "Signed";
      if (bits <= 16) { arg(0); simd((bits === 8 ? 0x7c : 0x7e) + (signed ? 0 : 1)); }
      else {
        for (let part = 0; part < 2; ++part) {
          arg(0); arg(0); simd(0x0d);
          for (let byte = 0; byte < 16; ++byte) body.byte((Math.floor(byte / 4) % 2) * 8 + part * 4 + byte % 4);
          simd(signed ? 0xc7 : 0xc9);
        }
        simd(vectorBinary.VectorAdd64!);
      }
    } else if (vectorSign) {
      const bytes = Number(vectorSign[2]) / 8;
      const negate = vectorSign[1] === "Neg";
      arg(0); simd(0x0c);
      for (let byte = 0; byte < 16; ++byte) {
        body.byte(byte % bytes === bytes - 1 ? negate ? 0x80 : 0x7f : negate ? 0 : 0xff);
      }
      simd(negate ? 0x51 : 0x4e);
    } else if (absoluteDifference) {
      const sign = absoluteDifference[1] === "Signed" ? "S" : "U";
      const bits = absoluteDifference[2]!;
      arg(0); arg(1); simd(vectorBinary[`VectorMax${sign}${bits}`]!);
      arg(0); arg(1); simd(vectorBinary[`VectorMin${sign}${bits}`]!);
      simd(vectorBinary[`VectorSub${bits}`]!);
    } else if (vectorShift) {
      const bits = Number(vectorShift[2]);
      const amount = immediate(node.args[1]!);
      const arithmetic = vectorShift[1] === "ArithmeticShiftRight";
      // ARM saturates oversized shifts; Wasm masks the count to the lane width.
      if (!arithmetic && amount >= bits) zeroVector();
      else {
        arg(0);
        if (amount !== 0) {
          constant(arithmetic ? Math.min(amount, bits - 1) : amount);
          simd(vectorShiftLeft[bits]! + (arithmetic ? 1 : vectorShift[1] === "LogicalShiftRight" ? 2 : 0));
        }
      }
    } else if (vectorUnary[node.op] !== undefined) {
      arg(0); simd(vectorUnary[node.op]!);
    } else if (binary[node.op] !== undefined) {
      arg(0); arg(1); body.byte(binary[node.op]!);
    } else if (vectorBinary[node.op] !== undefined) {
      arg(0); arg(1); simd(vectorBinary[node.op]!);
    } else switch (node.op) {
      case "Void": case "PushRSB": result = false; break;
      case "A32UpdateUpperLocationDescriptor":
        if (block.endCpsr === undefined) throw new JitError("compile", "ARM block is missing its end location");
        if (!hasBxWritePc) mergeFlags(0x0600fe20, () => constant(block.endCpsr));
        result = false;
        break;
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
      case "LogicalShiftLeft64": case "LogicalShiftRight64":
        arg(0); arg(1); body.byte(0xad).byte(node.op === "LogicalShiftLeft64" ? 0x86 : 0x88);
        body.byte(0x42).signed(0n, 64);
        arg(1); constant(64).byte(0x49).byte(0x1b);
        break;
      case "ArithmeticShiftRight64":
        arg(0); arg(1); constant(63); arg(1); constant(63).byte(0x49).byte(0x1b);
        body.byte(0xad).byte(0x87); break;
      case "RotateRight64": arg(0); arg(1); body.byte(0xad).byte(0x8a); break;
      case "A32GetRegister": load(options.layout.registers + immediate(node.args[0]!) * 4); break;
      case "A32SetRegister": store(options.layout.registers + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister32": load(options.layout.extendedRegisters + immediate(node.args[0]!) * 4); break;
      case "A32SetExtendedRegister32": store(options.layout.extendedRegisters + immediate(node.args[0]!) * 4, () => arg(1)); break;
      case "A32GetExtendedRegister64": load(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, true); break;
      case "A32SetExtendedRegister64": store(options.layout.extendedRegisters + (immediate(node.args[0]!) - 32) * 8, () => arg(1), true); break;
      case "ZeroVector": zeroVector(); break;
      case "ZeroExtendLongToQuad": vector64(() => arg(0)); break;
      case "VectorNot": arg(0); simd(0x4d); break;
      case "VectorTranspose8": case "VectorTranspose16":
      case "VectorTranspose32": case "VectorTranspose64": {
        const bytes = Number(node.op.match(/\d+$/)![0]) / 8;
        const part = immediate(node.args[2]!);
        arg(0); arg(1); simd(0x0d);
        for (let byte = 0; byte < 16; ++byte) {
          const lane = Math.floor(byte / bytes);
          body.byte((lane % 2) * 16 + (Math.floor(lane / 2) * 2 + part) * bytes + byte % bytes);
        }
        break;
      }
      case "VectorNarrow16": case "VectorNarrow32": case "VectorNarrow64": {
        const bytes = Number(node.op.match(/\d+$/)![0]) / 8;
        const half = bytes / 2;
        arg(0); zeroVector(); simd(0x0d);
        for (let byte = 0; byte < 16; ++byte) {
          body.byte(byte < 8 ? Math.floor(byte / half) * bytes + byte % half : 16);
        }
        break;
      }
      case "VectorPolynomialMultiply8": case "VectorPolynomialMultiplyLong8": {
        const wide = node.op === "VectorPolynomialMultiplyLong8";
        const bits = wide ? 16 : 8;
        zeroVector();
        for (let bit = 0; bit < 8; ++bit) {
          arg(0); if (wide) simd(0x89);
          if (bit > 0) { constant(bit); simd(vectorShiftLeft[bits]!); }
          arg(1); if (wide) simd(0x89);
          constant(1 << bit); simd(laneSplat[bits]!); simd(0x4e);
          constant(1 << bit); simd(laneSplat[bits]!); simd(vectorBinary[`VectorEqual${bits}`]!);
          simd(0x4e); simd(0x51);
        }
        break;
      }
      case "VectorMultiply8":
        arg(0); simd(0x89); arg(1); simd(0x89); simd(0x95);
        arg(0); simd(0x8a); arg(1); simd(0x8a); simd(0x95);
        // Keep the low byte of each product without saturating the halfwords.
        simd(0x0d);
        for (let lane = 0; lane < 16; ++lane) body.byte(lane * 2);
        break;
      case "VectorZeroUpper": case "VectorZeroExtend64":
        arg(0); body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); break;
      case "VectorSignExtend64":
        arg(0); arg(0); simd(0x1d).byte(0);
        body.byte(0x42).signed(63n, 64).byte(0x87); simd(0x1e).byte(1); break;
      case "VectorGetElement8": case "VectorGetElement16":
      case "VectorGetElement32": case "VectorGetElement64":
      case "VectorSetElement8": case "VectorSetElement16":
      case "VectorSetElement32": case "VectorSetElement64": {
        const bits = Number(node.op.match(/\d+$/)![0]);
        const lane = immediate(node.args[1]!);
        if (lane < 0 || lane >= 128 / bits) throw new JitError("compile", "Invalid ARM vector lane");
        arg(0);
        if (node.op.startsWith("VectorSet")) {
          arg(2); simd(laneReplace[bits]!).byte(lane);
        } else simd(laneExtract[bits]!).byte(lane);
        break;
      }
      case "VectorBroadcast8": case "VectorBroadcast16": case "VectorBroadcast32": case "VectorBroadcast64":
      case "VectorBroadcastLower8": case "VectorBroadcastLower16": case "VectorBroadcastLower32":
      case "VectorBroadcastElement8": case "VectorBroadcastElement16":
      case "VectorBroadcastElement32": case "VectorBroadcastElement64":
      case "VectorBroadcastElementLower8": case "VectorBroadcastElementLower16": case "VectorBroadcastElementLower32": {
        const bits = Number(node.op.match(/\d+$/)![0]);
        arg(0);
        if (node.op.includes("Element")) {
          const lane = immediate(node.args[1]!);
          if (lane < 0 || lane >= 128 / bits) throw new JitError("compile", "Invalid ARM broadcast lane");
          simd(laneExtract[bits]!).byte(lane);
        }
        simd(laneSplat[bits]!);
        if (node.op.includes("Lower")) { body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); }
        break;
      }
      case "VectorExtract": case "VectorExtractLower": {
        const lower = node.op === "VectorExtractLower";
        const width = lower ? 8 : 16;
        const position = immediate(node.args[2]!);
        if (position % 8 !== 0 || position < 0 || position > width * 8) {
          throw new JitError("compile", "Invalid ARM vector extraction position");
        }
        arg(0); arg(1); simd(0x0d);
        for (let lane = 0; lane < 16; ++lane) {
          const source = lane + position / 8;
          body.byte(lower && lane >= 8 ? 0 : source < width ? source : 16 + source - width);
        }
        if (lower) { body.byte(0x42).signed(0n, 64); simd(0x1e).byte(1); }
        break;
      }
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
        if (block.endCpsr === undefined) throw new JitError("compile", "ARM block is missing its end location");
        store(options.layout.registers + 60, () => {
          arg(0); constant(-2); constant(-4); arg(0); constant(1).byte(0x71).byte(0x1b).byte(0x71);
        });
        // Native BX lowering takes IT/E from the block's end location and T from the branch target.
        mergeFlags(0x0600fe20, () => {
          constant(block.endCpsr & 0x0600fe00);
          arg(0); constant(1).byte(0x71); constant(5).byte(0x74).byte(0x72);
        });
        break;
      case "A32GetFpscr": load(options.layout.fpscr); break;
      case "A32SetFpscr": store(options.layout.fpscr, () => arg(0)); break;
      case "A32GetFpscrNZCV": load(options.layout.fpscr); constant(0xf0000000).byte(0x71); break;
      case "A32SetFpscrNZCV": store(options.layout.fpscr, () => {
        load(options.layout.fpscr); constant(0x0fffffff).byte(0x71);
        arg(0); constant(0xf0000000).byte(0x71).byte(0x72);
      }); break;
      case "A32GetCFlag": bit(0x20000000); break;
      case "A32SetGEFlagsCompressed": mergeFlags(0x000f0000, () => arg(0)); break;
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
      case "A32SetCpsrNZC": {
        const carryOnly = "imm" in node.args[0]!;
        mergeFlags(carryOnly ? 0x20000000 : 0xe0000000, () => {
          if (!carryOnly) { arg(0); constant(0xc0000000).byte(0x71); }
          arg(1); constant(29).byte(0x74);
          if (!carryOnly) body.byte(0x72);
        });
        break;
      }
      case "A32OrQFlag": mergeFlags(0x08000000, () => {
        load(options.layout.cpsr); arg(0); constant(27).byte(0x74).byte(0x72);
      }); break;
      case "NZCVFromPackedFlags": arg(0); break;
      case "GetCFlagFromNZCV": arg(0); constant(29).byte(0x76); constant(1).byte(0x71); break;
      case "GetCarryFromOp": carry((node.args[0] as { ref: number }).ref); break;
      case "GetOverflowFromOp": overflow((node.args[0] as { ref: number }).ref); break;
      case "GetGEFromOp": packed(block.nodes[(node.args[0] as { ref: number }).ref]!, true); break;
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
      case "SignedSaturatedAddWithFlag32": case "SignedSaturatedSubWithFlag32": {
        const subtract = node.op === "SignedSaturatedSubWithFlag32";
        arg(0); arg(1); body.byte(subtract ? 0x6b : 0x6a); set(index + 2);
        arg(0); arg(1); body.byte(0x73);
        if (!subtract) constant(-1).byte(0x73);
        arg(0); get(index + 2).byte(0x73).byte(0x71); constant(31).byte(0x76);
        set(overflowLocals.get(index)!);
        constant(0x7fffffff); arg(0); constant(31).byte(0x75).byte(0x73);
        get(index + 2); get(overflowLocals.get(index)!).byte(0x1b);
        break;
      }
      case "SignedSaturation": case "UnsignedSaturation": {
        const signed = node.op === "SignedSaturation";
        const bits = immediate(node.args[1]!);
        if (bits < (signed ? 1 : 0) || bits > (signed ? 32 : 31)) {
          throw new JitError("compile", "Invalid ARM saturation width");
        }
        const minimum = signed ? -(2 ** (bits - 1)) : 0;
        const maximum = 2 ** (signed ? bits - 1 : bits) - 1;
        constant(minimum); arg(0); arg(0); constant(minimum).byte(0x48).byte(0x1b);
        set(index + 2);
        constant(maximum); get(index + 2); get(index + 2);
        constant(maximum).byte(0x4a).byte(0x1b);
        break;
      }
      case "PackedSelect":
        arg(1); arg(0); constant(-1).byte(0x73).byte(0x71);
        arg(2); arg(0); body.byte(0x71).byte(0x72); break;
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
        arg(0); simd(0x11); arg(1); simd(0x11); simd(0x79);
        arg(0); simd(0x11); arg(1); simd(0x11); simd(0x77);
        simd(0x71); simd(0x7d); simd(0x7f); simd(0x1b).byte(0);
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
    if (options.execution && (node.op === "A32CallSupervisor" || node.op === "A32ExceptionRaised")) {
      // These native callbacks flush prior ticks and refresh the remaining budget.
      load(options.execution.budget, true); set(1);
    }
  });
  terminal(block.terminal);
  // Every terminal path returns or tail-calls, including both branches of a conditional exit.
  body.byte(0x00);
  return regionModule({ imports, shared: options.shared, maximumPages: options.maximumPages,
    signature: { params: ["i32", "i64"], results: ["i64"] }, locals, body,
    table: Boolean(block.sourceCell) });
}
