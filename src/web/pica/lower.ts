// SPDX-License-Identifier: GPL-2.0-or-later

import { Bytes, regionModule } from "../wasm/binary";
import type { FunctionImport, ValueType } from "../wasm/binary";
import { Op, opcode as decodeOpcode } from "./instruction";
import { controlFlow, emitControlFlow } from "./control-flow";

export interface PicaLayout {
  floatUniforms: number;
  boolUniforms: number;
  intUniforms: number;
  input: number;
  temporary: number;
  output: number;
  outputBank: number;
  addressRegisters: number;
  conditionalCode: number;
}

export interface PicaOptions {
  layout: PicaLayout;
  shared: boolean;
  maximumPages: number;
  dispatch?: boolean;
}

export class PicaEmitter {
  readonly body = new Bytes();
  readonly imports: FunctionImport[] = [];
  readonly locals: ValueType[] = ["v128", "v128", "v128", "v128", "i32", "i32"];
  readonly a = 2;
  readonly b = 3;
  readonly c = 4;
  readonly result = 5;
  readonly pointer = 6;
  readonly index = 7;
  depth = 0;
  readonly breaks: number[] = [];
  readonly calls: number[] = [];

  constructor(readonly program: Uint32Array, readonly swizzles: Uint32Array,
    readonly options: PicaOptions) {}

  get(local: number): this { this.body.byte(0x20).u32(local); return this; }
  set(local: number): this { this.body.byte(0x21).u32(local); return this; }
  constant(value: number): this { this.body.byte(0x41).i32(value); return this; }
  simd(op: number): this { this.body.byte(0xfd).u32(op); return this; }

  address(base: number, offset: number): this {
    this.get(base);
    if (offset) this.constant(offset).body.byte(0x6a);
    return this;
  }

  vector(bits: readonly number[]): this {
    this.simd(12);
    for (const lane of bits) {
      for (let shift = 0; shift < 32; shift += 8) this.body.byte(lane >>> shift);
    }
    return this;
  }

  scalar(value: number): this {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setFloat32(0, value, true);
    this.body.byte(0x43).append(data);
    return this;
  }

  helper(name: string, params: ValueType[], results: ValueType[]): this {
    let index = this.imports.findIndex((item) => item.name === name);
    if (index < 0) {
      index = this.imports.length;
      this.imports.push({ module: "core", name, type: { params, results } });
    }
    this.body.byte(0x10).u32(index);
    return this;
  }

  local(type: ValueType): number {
    const index = this.locals.length + 2;
    this.locals.push(type);
    return index;
  }

  open(opcode: number): this {
    this.body.byte(opcode).byte(0x40);
    ++this.depth;
    return this;
  }

  close(): this {
    this.body.byte(0x0b);
    --this.depth;
    return this;
  }

  condition(word: number, uniform: boolean): undefined {
    const layout = this.options.layout;
    if (uniform) {
      this.address(0, layout.boolUniforms + ((word >>> 22) & 15));
      this.body.byte(0x2d).u32(0).u32(0);
      return undefined;
    }
    const mode = (word >>> 22) & 3;
    for (let lane = 0; lane < 2; ++lane) {
      if ((mode === 2 && lane === 1) || (mode === 3 && lane === 0)) continue;
      this.address(1, layout.conditionalCode + lane).body.byte(0x2d).u32(0).u32(0);
      this.constant((word >>> (lane === 0 ? 25 : 24)) & 1).body.byte(0x46);
    }
    if (mode < 2) this.body.byte(mode === 0 ? 0x72 : 0x71);
    return undefined;
  }

  source(register: number, relative: number, swizzle: number, operand: 1 | 2 | 3,
    local: number): undefined {
    const layout = this.options.layout;
    if (register < 32) {
      this.address(1, (register < 16 ? layout.input : layout.temporary) + (register & 15) * 16);
      this.simd(0).body.u32(4).u32(0);
    } else if (!relative) {
      if (register - 32 >= 96) throw new Error("PICA float uniform is out of range");
      this.address(0, layout.floatUniforms + (register - 32) * 16);
      this.simd(0).body.u32(4).u32(0);
    } else {
      this.address(1, layout.addressRegisters + (relative - 1) * 4).body.byte(0x28).u32(2).u32(0);
      this.set(this.index).get(this.index).constant(128).body.byte(0x6a);
      this.constant(256).body.byte(0x49).byte(0x04).byte(0x7f);
      this.get(this.index).body.byte(0x05);
      this.constant(0).body.byte(0x0b);
      this.constant(register - 32).body.byte(0x6a);
      this.constant(127).body.byte(0x71);
      this.set(this.index).get(this.index).constant(96).body.byte(0x49).byte(0x04).byte(0x7b);
      this.address(0, layout.floatUniforms).get(this.index).constant(4).body.byte(0x74).byte(0x6a);
      this.simd(0).body.u32(4).u32(0).byte(0x05);
      this.vector([0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000]).body.byte(0x0b);
    }
    const selectorShift = [5, 14, 23][operand - 1]!;
    const selector = (swizzle >>> selectorShift) & 255;
    if (selector !== 0x1b) {
      this.set(local).get(local).get(local).simd(13);
      for (let lane = 0; lane < 4; ++lane) {
        const selected = (selector >>> ((3 - lane) * 2)) & 3;
        for (let byte = 0; byte < 4; ++byte) this.body.byte(selected * 4 + byte);
      }
    }
    if (swizzle & (1 << (selectorShift - 1))) this.simd(225);
    this.set(local);
    return undefined;
  }

  multiply(): undefined {
    this.get(this.a).get(this.b).simd(230).set(this.result);
    // PICA maps 0 * infinity to +0, while NaN operands still propagate.
    this.get(this.result).get(this.a).get(this.a).simd(65);
    this.get(this.b).get(this.b).simd(65).simd(78);
    this.get(this.result).get(this.result).simd(66).simd(78).simd(79);
    return undefined;
  }

  destination(register: number, mask: number): undefined {
    const layout = this.options.layout;
    if (!mask) { this.body.byte(0x1a); return undefined; }
    this.set(this.result);
    if (register < 16) {
      this.address(1, layout.output);
      this.address(1, layout.outputBank).body.byte(0x2d).u32(0).u32(0);
      this.constant(8).body.byte(0x74).byte(0x6a);
      this.constant(register * 16).body.byte(0x6a);
    } else {
      this.address(1, layout.temporary + (register - 16) * 16);
    }
    this.set(this.pointer).get(this.pointer).get(this.result);
    if (mask !== 15) {
      this.get(this.pointer).simd(0).body.u32(4).u32(0);
      this.vector([0, 1, 2, 3].map((lane) => mask & (8 >>> lane) ? 0xffffffff : 0));
      this.simd(82);
    }
    this.simd(11).body.u32(4).u32(0);
    return undefined;
  }

  arithmetic(word: number, opcode: number): undefined {
    const mad = opcode >= Op.MADI;
    const inverted = mad ? opcode === Op.MADI :
      opcode === Op.DPHI || opcode === Op.SGEI || opcode === Op.SLTI;
    const swizzle = this.swizzles[word & (mad ? 31 : 127)]!;
    const relative = (word >>> (mad ? 22 : 19)) & 3;
    const src1 = mad ? (word >>> 17) & 31 :
      (word >>> (inverted ? 14 : 12)) & (inverted ? 31 : 127);
    const src2 = mad ? (word >>> (inverted ? 12 : 10)) & (inverted ? 31 : 127) :
      (word >>> 7) & (inverted ? 127 : 31);
    this.source(src1, !mad && !inverted ? relative : 0, swizzle, 1, this.a);
    if (!new Set<number>([Op.MOV, Op.MOVA, Op.EX2, Op.LG2, Op.FLR, Op.RCP, Op.RSQ]).has(opcode)) {
      this.source(src2, (mad ? !inverted : inverted) ? relative : 0, swizzle, 2, this.b);
    }
    if (mad) {
      this.source((word >>> 5) & (inverted ? 127 : 31), inverted ? relative : 0,
        swizzle, 3, this.c);
      this.multiply();
      this.get(this.c).simd(228);
    } else switch (opcode) {
      case Op.ADD: this.get(this.a).get(this.b).simd(228); break;
      case Op.MUL: this.multiply(); break;
      case Op.MOV: this.get(this.a); break;
      case Op.FLR: this.get(this.a).simd(104); break;
      case Op.MAX: case Op.MIN:
        this.get(this.a).get(this.b).get(this.a).get(this.b).simd(opcode === Op.MAX ? 68 : 67).simd(82);
        break;
      case Op.SGE: case Op.SGEI: case Op.SLT: case Op.SLTI:
        this.get(this.a).get(this.b).simd(opcode === Op.SGE || opcode === Op.SGEI ? 70 : 67);
        this.vector([0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000]).simd(78);
        break;
      case Op.RCP: case Op.RSQ:
        this.scalar(1).get(this.a).simd(31).body.byte(0);
        if (opcode === Op.RSQ) this.body.byte(0x91);
        this.body.byte(0x95);
        this.simd(19);
        break;
      case Op.EX2: case Op.LG2:
        this.get(this.a).simd(31).body.byte(0);
        this.helper(opcode === Op.EX2 ? "WasmPicaExp2" : "WasmPicaLog2", ["f32"], ["f32"]).simd(19);
        break;
      case Op.DP3: case Op.DP4: case Op.DPH: case Op.DPHI:
        if (opcode === Op.DPH || opcode === Op.DPHI) {
          this.get(this.a).scalar(1).simd(32).body.byte(3);
          this.set(this.a);
        }
        this.multiply();
        this.set(this.result).scalar(0);
        for (let lane = 0; lane < (opcode === Op.DP3 ? 3 : 4); ++lane) {
          this.get(this.result).simd(31).body.byte(lane).byte(0x92);
        }
        this.simd(19);
        break;
      case Op.MOVA:
        for (let lane = 0; lane < 2; ++lane) {
          if (!(swizzle & (8 >>> lane))) continue;
          this.address(1, this.options.layout.addressRegisters + lane * 4);
          this.get(this.a).simd(31).body.byte(lane).byte(0xfc).u32(0);
          this.body.byte(0x36).u32(2).u32(0);
        }
        return undefined;
      case Op.CMP:
        for (let lane = 0; lane < 2; ++lane) {
          const comparison = (word >>> (lane === 0 ? 24 : 21)) & 7;
          const comparisons = [0x5b, 0x5c, 0x5d, 0x5f, 0x5e, 0x60];
          const instruction = comparisons[comparison];
          if (instruction === undefined) throw new Error("Unsupported PICA comparison mode");
          this.address(1, this.options.layout.conditionalCode + lane);
          this.get(this.a).simd(31).body.byte(lane);
          this.get(this.b).simd(31).body.byte(lane).byte(instruction).byte(0x3a).u32(0).u32(0);
        }
        return undefined;
      default: throw new Error(`Unsupported PICA arithmetic opcode ${opcode}`);
    }
    this.destination((word >>> (mad ? 24 : 21)) & 31, swizzle & 15);
    return undefined;
  }

  range(start: number, end: number): boolean {
    if (start < 0 || start > 4096 || end < start || end > 4096) {
      throw new Error("Invalid PICA control-flow range");
    }
    for (let pc = start; pc < end; ++pc) {
      const word = this.program[pc]!;
      const opcode = decodeOpcode(word, pc);
      if (opcode === Op.END || pc === 4095) { this.body.byte(0x0f); return true; }
      if (opcode === Op.NOP) continue;
      if (opcode === Op.EMIT || opcode === Op.SETEMIT) {
        this.get(1);
        if (opcode === Op.SETEMIT) this.constant((word >>> 22) & 15);
        this.helper(opcode === Op.EMIT ? "WasmPicaEmit" : "WasmPicaSetEmit",
          opcode === Op.EMIT ? ["i32"] : ["i32", "i32"], []);
      } else if (opcode < 32 || opcode === Op.CMP || opcode >= 48) {
        this.arithmetic(word, opcode);
      } else if (opcode === Op.CALL || opcode === Op.CALLC || opcode === Op.CALLU) {
        const destination = (word >>> 10) & 4095;
        const count = word & 255;
        if (this.calls.length >= 4 || this.calls.includes(destination)) {
          throw new Error("PICA call nesting exceeds the hardware stack");
        }
        const conditional = opcode !== Op.CALL;
        if (conditional) { this.condition(word, opcode === Op.CALLU); this.open(0x04); }
        this.calls.push(destination);
        const stops = this.range(destination, destination + count);
        this.calls.pop();
        if (conditional) this.close();
        else if (stops) return true;
      } else if (opcode === Op.IFU || opcode === Op.IFC) {
        const otherwise = (word >>> 10) & 4095;
        const after = otherwise + (word & 255);
        this.condition(word, opcode === Op.IFU);
        this.open(0x04);
        const thenStops = this.range(pc + 1, otherwise);
        let elseStops = false;
        if (word & 255) { this.body.byte(0x05); elseStops = this.range(otherwise, after); }
        this.close();
        if (thenStops && elseStops) return true;
        pc = after - 1;
      } else if (opcode === Op.LOOP) {
        const after = ((word >>> 10) & 4095) + 1;
        const parameters = this.local("i32");
        const counter = this.local("i32");
        const increment = this.local("i32");
        const previous = this.local("i32");
        const nested = this.breaks.length > 0;
        const address = this.options.layout.addressRegisters + 8;
        if (this.breaks.length >= 4) throw new Error("PICA loop nesting exceeds the hardware stack");
        if (nested) {
          this.address(1, address).body.byte(0x28).u32(2).u32(0);
          this.set(previous);
        }
        this.address(0, this.options.layout.intUniforms + ((word >>> 22) & 3) * 4);
        this.body.byte(0x28).u32(2).u32(0);
        this.set(parameters).get(parameters).constant(255).body.byte(0x71);
        this.constant(1).body.byte(0x6a);
        this.set(counter).get(parameters).constant(16).body.byte(0x76);
        this.constant(255).body.byte(0x71);
        this.set(increment).address(1, address).get(parameters).constant(8).body.byte(0x76);
        this.constant(255).body.byte(0x71).byte(0x36).u32(2).u32(0);
        this.open(0x02);
        this.breaks.push(this.depth);
        this.open(0x03);
        const stops = this.range(pc + 1, after);
        this.address(1, address).address(1, address).body.byte(0x28).u32(2).u32(0);
        this.get(increment).body.byte(0x6a).byte(0x36).u32(2).u32(0);
        this.get(counter).constant(1).body.byte(0x6b).byte(0x22).u32(counter).byte(0x0d).u32(0);
        this.close().close();
        this.breaks.pop();
        if (nested) this.address(1, address).get(previous).body.byte(0x36).u32(2).u32(0);
        if (stops) return true;
        pc = after - 1;
      } else if (opcode === Op.BREAK || opcode === Op.BREAKC) {
        const target = this.breaks.at(-1);
        if (target === undefined) throw new Error("PICA break is outside a loop");
        if (opcode === Op.BREAKC) this.condition(word, false);
        this.body.byte(opcode === Op.BREAKC ? 0x0d : 0x0c).u32(this.depth - target);
      } else {
        throw new Error(`Unsupported PICA flow opcode ${opcode} at ${pc}`);
      }
    }
    return false;
  }

  structured(start: number, end: number, calls: number[] = [], loops = 0, depth = 0): boolean {
    if (start < 0 || end < start || end > 4096 || depth > 12) return false;
    for (let pc = start; pc < end; ++pc) {
      const word = this.program[pc]!;
      const op = decodeOpcode(word, pc);
      if (op === Op.END) return true;
      const destination = (word >>> 10) & 4095;
      const count = word & 255;
      if (op === Op.JMPC || op === Op.JMPU) return false;
      if (op === Op.CALL || op === Op.CALLC || op === Op.CALLU) {
        if (calls.length >= 4 || calls.includes(destination) ||
          !this.structured(destination, destination + count, [...calls, destination], loops, depth + 1)) {
          return false;
        }
      } else if (op === Op.IFC || op === Op.IFU) {
        if (destination < pc + 1 || destination + count > end ||
          !this.structured(pc + 1, destination, calls, loops, depth + 1) ||
          !this.structured(destination, destination + count, calls, loops, depth + 1)) return false;
        pc = destination + count - 1;
      } else if (op === Op.LOOP) {
        if (loops >= 4 || destination < pc || destination + 1 > end ||
          !this.structured(pc + 1, destination + 1, calls, loops + 1, depth + 1)) return false;
        pc = destination;
      } else if ((op === Op.BREAK || op === Op.BREAKC) && !loops) return false;
    }
    return true;
  }

  compile(entry: number): Uint8Array<ArrayBuffer> {
    const graph = controlFlow(this.program, entry);
    if (this.options.dispatch || graph.hasJumps || !this.structured(entry, this.program.length)) {
      emitControlFlow(this, graph, entry);
    } else this.range(entry, this.program.length);
    return regionModule({ ...this.options, imports: this.imports,
      signature: { params: ["i32", "i32"], results: [] }, locals: this.locals, body: this.body });
  }
}

export function lowerPica(program: Uint32Array, swizzles: Uint32Array,
  entry: number, options: PicaOptions): Uint8Array<ArrayBuffer> {
  if (program.length !== 4096 || swizzles.length !== 4096 ||
    !Number.isInteger(entry) || entry < 0 || entry >= 4096) {
    throw new Error("Invalid PICA shader program");
  }
  return new PicaEmitter(program, swizzles, options).compile(entry);
}
