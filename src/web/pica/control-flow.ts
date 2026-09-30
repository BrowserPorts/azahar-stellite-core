// SPDX-License-Identifier: GPL-2.0-or-later

import { Op, opcode } from "./instruction";
import type { PicaEmitter } from "./lower";

interface Graph {
  blocks: number[][];
  hasJumps: boolean;
}

/** Discover executable blocks, including the destinations of implicit scope returns. */
export function controlFlow(program: Uint32Array, entry: number): Graph {
  const visited = new Set<number>();
  const leaders = new Set([entry]);
  const pending = [entry];
  const scopeEdges = new Map<number, Set<number>>();
  const breaks = new Set<number>();
  const loopEnds = new Set<number>();
  let hasJumps = false;
  const visit = (pc: number, leader = true): undefined => {
    if (pc < 0) throw new Error("PICA branch target is out of range");
    pc = Math.min(pc, 4095);
    if (leader) leaders.add(pc);
    if (!visited.has(pc)) pending.push(pc);
    return undefined;
  };
  const scopeEdge = (last: number, target: number): undefined => {
    if (last < -1 || target < 0) {
      throw new Error("PICA scope boundary is out of range");
    }
    if (last === -1 || last >= 4095) return undefined;
    leaders.add(last + 1);
    const edges = scopeEdges.get(last) ?? new Set<number>();
    edges.add(target);
    scopeEdges.set(last, edges);
    if (visited.has(last) && opcode(program[last]!, last) !== Op.END) visit(target);
    return undefined;
  };
  while (pending.length) {
    const pc = pending.pop()!;
    if (visited.has(pc)) continue;
    visited.add(pc);
    const word = program[pc]!;
    const op = opcode(word, pc);
    if (op === Op.END) continue;
    const destination = (word >>> 10) & 4095;
    const count = word & 255;
    if (op === Op.CALL || op === Op.CALLC || op === Op.CALLU) {
      if (count) {
        visit(destination);
        scopeEdge(destination + count - 1, pc + 1);
      }
      if (!count || op !== Op.CALL) visit(pc + 1);
    } else if (op === Op.IFC || op === Op.IFU) {
      visit(pc + 1);
      visit(destination);
      scopeEdge(destination - 1, destination + count);
    } else if (op === Op.LOOP) {
      visit(pc + 1);
      scopeEdge(destination, pc + 1);
      scopeEdge(destination, destination + 1);
      loopEnds.add(destination + 1);
      if (breaks.size) visit(destination + 1);
    } else if (op === Op.JMPC || op === Op.JMPU) {
      hasJumps = true;
      visit(destination);
      visit(pc + 1);
    } else if (op === Op.BREAK || op === Op.BREAKC) {
      breaks.add(pc);
      for (const end of loopEnds) visit(end);
      if (op === Op.BREAKC) visit(pc + 1);
    } else {
      visit(pc + 1, false);
    }
    for (const target of scopeEdges.get(pc) ?? []) visit(target);
  }
  const blocks: number[][] = [];
  for (const pc of [...visited].sort((a, b) => a - b)) {
    const previous = blocks.at(-1);
    if (!previous || leaders.has(pc) || previous.at(-1)! + 1 !== pc) blocks.push([pc]);
    else previous.push(pc);
  }
  return { blocks, hasJumps };
}

interface Stack {
  depth: number;
  fields: number[][];
}

class FlowEmitter {
  readonly pc: number;
  readonly next: number;
  readonly checked: number;
  readonly breaking: number;
  readonly parameters: number;
  readonly remaining: number;
  readonly calls: Stack;
  readonly ifs: Stack;
  readonly loops: Stack;

  constructor(readonly e: PicaEmitter) {
    this.pc = e.local("i32");
    this.next = e.local("i32");
    this.checked = e.local("i32");
    this.breaking = e.local("i32");
    this.parameters = e.local("i32");
    this.remaining = e.local("i32");
    this.calls = this.stack(4, 2);
    this.ifs = this.stack(8, 2);
    this.loops = this.stack(4, 5);
  }

  stack(capacity: number, fields: number): Stack {
    return { depth: this.e.local("i32"), fields: Array.from({ length: fields }, () =>
      Array.from({ length: capacity }, () => this.e.local("i32"))) };
  }

  pick(stack: Stack, field: number): undefined {
    const e = this.e;
    const values = stack.fields[field]!;
    e.get(values[0]!);
    for (let index = 1; index < values.length; ++index) {
      e.get(values[index]!).get(stack.depth).constant(index + 1).body.byte(0x47).byte(0x1b);
    }
    return undefined;
  }

  push(stack: Stack, values: (() => unknown)[]): undefined {
    const e = this.e;
    const capacity = stack.fields[0]!.length;
    // The hardware stacks retain the newest scopes when their capacity is exceeded.
    e.get(stack.depth).constant(capacity).body.byte(0x46);
    e.open(0x04);
    for (const field of stack.fields) {
      for (let index = 0; index < capacity - 1; ++index) e.get(field[index + 1]!).set(field[index]!);
    }
    e.constant(capacity - 1).set(stack.depth).close();
    for (let index = 0; index < capacity; ++index) {
      e.get(stack.depth).constant(index).body.byte(0x46);
      e.open(0x04);
      values.forEach((value, field) => { value(); e.set(stack.fields[field]![index]!); });
      e.close();
    }
    e.get(stack.depth).constant(1).body.byte(0x6a);
    e.set(stack.depth);
    return undefined;
  }

  pop(stack: Stack): undefined {
    this.e.get(stack.depth).constant(1).body.byte(0x6b);
    this.e.set(stack.depth);
    return undefined;
  }

  writeTop(stack: Stack, field: number, value: number): undefined {
    const e = this.e;
    stack.fields[field]!.forEach((local, index) => {
      e.get(stack.depth).constant(index + 1).body.byte(0x46);
      e.open(0x04).get(value).set(local).close();
    });
    return undefined;
  }

  endCalls(oldNext: number): undefined {
    const e = this.e;
    e.constant(oldNext).set(this.checked).open(0x02);
    const exit = e.depth;
    for (let index = 0; index < 4; ++index) {
      e.get(this.calls.depth).body.byte(0x45).byte(0x0d).u32(e.depth - exit);
      this.pick(this.calls, 0);
      e.get(this.checked).body.byte(0x47).byte(0x0d).u32(e.depth - exit);
      // PICA's fourth simultaneous CALL return discards the scope without updating the PC.
      if (index < 3) { this.pick(this.calls, 1); e.set(this.next).get(this.next).set(this.checked); }
      this.pop(this.calls);
    }
    e.close();
    return undefined;
  }

  endIf(oldNext: number): undefined {
    const e = this.e;
    e.get(this.ifs.depth);
    e.open(0x04);
    this.pick(this.ifs, 0);
    e.constant(oldNext).body.byte(0x46);
    e.open(0x04);
    this.pick(this.ifs, 1);
    e.set(this.next);
    this.pop(this.ifs);
    e.close().close();
    return undefined;
  }

  endLoops(oldNext: number): undefined {
    const e = this.e;
    const address = e.options.layout.addressRegisters + 8;
    e.open(0x02);
    const exit = e.depth;
    for (let index = 0; index < 4; ++index) {
      e.get(this.loops.depth).body.byte(0x45).byte(0x0d).u32(e.depth - exit);
      this.pick(this.loops, 1);
      e.constant(oldNext).body.byte(0x46);
      e.get(this.breaking).body.byte(0x72).byte(0x45).byte(0x0d).u32(e.depth - exit);
      e.get(this.breaking).body.byte(0x45);
      e.open(0x04);
      e.address(1, address).address(1, address).body.byte(0x28).u32(2).u32(0);
      this.pick(this.loops, 3);
      e.body.byte(0x6a).byte(0x36).u32(2).u32(0);
      this.pick(this.loops, 2);
      e.constant(1).body.byte(0x6b);
      e.set(this.remaining);
      this.writeTop(this.loops, 2, this.remaining);
      e.get(this.remaining);
      e.open(0x04);
      this.pick(this.loops, 0);
      e.set(this.next).body.byte(0x0c).u32(e.depth - exit);
      e.close().close();
      this.pick(this.loops, 1);
      e.set(this.next);
      e.get(this.loops.depth).constant(1).body.byte(0x4b);
      e.open(0x04).address(1, address);
      this.pick(this.loops, 4);
      e.body.byte(0x36).u32(2).u32(0);
      e.close();
      this.pop(this.loops);
      e.get(this.breaking).body.byte(0x0d).u32(e.depth - exit);
    }
    e.close();
    return undefined;
  }

  instruction(pc: number): undefined {
    const e = this.e;
    const word = e.program[pc]!;
    const op = opcode(word, pc);
    const destination = (word >>> 10) & 4095;
    const count = word & 255;
    if (op === Op.END) { e.body.byte(0x0f); return undefined; }
    if (op === Op.CALL || op === Op.CALLC || op === Op.CALLU) {
      if (!count) return undefined;
      if (op !== Op.CALL) { e.condition(word, op === Op.CALLU); e.open(0x04); }
      this.push(this.calls, [() => e.constant(destination + count), () => e.constant(pc + 1)]);
      e.constant(destination).set(this.next);
      if (op !== Op.CALL) e.close();
    } else if (op === Op.IFC || op === Op.IFU) {
      e.condition(word, op === Op.IFU);
      e.open(0x04);
      this.push(this.ifs, [() => e.constant(destination), () => e.constant(destination + count)]);
      e.body.byte(0x05);
      e.constant(destination).set(this.next).close();
    } else if (op === Op.LOOP) {
      const address = e.options.layout.addressRegisters + 8;
      e.address(0, e.options.layout.intUniforms + ((word >>> 22) & 3) * 4);
      e.body.byte(0x28).u32(2).u32(0);
      e.set(this.parameters);
      this.push(this.loops, [() => e.constant(pc + 1), () => e.constant(destination + 1),
        () => { e.get(this.parameters).constant(255).body.byte(0x71); return e.constant(1).body.byte(0x6a); },
        () => { e.get(this.parameters).constant(16).body.byte(0x76); return e.constant(255).body.byte(0x71); },
        () => e.address(1, address).body.byte(0x28).u32(2).u32(0)]);
      e.address(1, address).get(this.parameters).constant(8).body.byte(0x76);
      e.constant(255).body.byte(0x71).byte(0x36).u32(2).u32(0);
    } else if (op === Op.JMPC || op === Op.JMPU) {
      e.constant(destination).constant(pc + 1);
      e.condition(word, op === Op.JMPU);
      if (op === Op.JMPU && (count & 1)) e.body.byte(0x45);
      e.body.byte(0x1b);
      e.set(this.next);
    } else if (op === Op.BREAK || op === Op.BREAKC) {
      if (op === Op.BREAKC) e.condition(word, false);
      else e.constant(1);
      e.set(this.breaking);
    } else if (op === Op.EMIT || op === Op.SETEMIT) {
      e.get(1);
      if (op === Op.SETEMIT) e.constant((word >>> 22) & 15);
      e.helper(op === Op.EMIT ? "WasmPicaEmit" : "WasmPicaSetEmit",
        op === Op.EMIT ? ["i32"] : ["i32", "i32"], []);
    } else if (op !== Op.NOP) {
      e.arithmetic(word, op);
    }
    return undefined;
  }

  emit(graph: Graph, entry: number): undefined {
    const e = this.e;
    const blockByPc = new Map(graph.blocks.map((block, index) => [block[0]!, index]));
    const maximum = Math.max(...blockByPc.keys());
    e.constant(entry).set(this.pc).open(0x03).open(0x02);
    for (let index = 0; index < graph.blocks.length; ++index) e.open(0x02);
    e.get(this.pc).body.byte(0x0e).u32(maximum + 1);
    for (let pc = 0; pc <= maximum; ++pc) e.body.u32(blockByPc.get(pc) ?? graph.blocks.length);
    e.body.u32(graph.blocks.length);
    for (const block of graph.blocks) {
      e.close();
      const last = block.at(-1)!;
      e.constant(last + 1).set(this.next).constant(0).set(this.breaking);
      for (const pc of block) this.instruction(pc);
      if (opcode(e.program[last]!, last) !== Op.END) {
        this.endCalls(last + 1);
        this.endIf(last + 1);
        this.endLoops(last + 1);
        // Azahar treats execution reaching the final code word or beyond it as END.
        e.get(this.next).constant(4095).body.byte(0x4f);
        e.open(0x04).body.byte(0x0f);
        e.close();
        e.get(this.next).set(this.pc).body.byte(0x0c).u32(e.depth - 1);
      }
    }
    e.close().body.byte(0x00);
    e.close();
    return undefined;
  }
}

/** Branch selection targets compiled basic blocks; guest instructions are never decoded at run time. */
export function emitControlFlow(emitter: PicaEmitter, graph: Graph, entry: number): undefined {
  return new FlowEmitter(emitter).emit(graph, entry);
}
