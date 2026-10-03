// SPDX-License-Identifier: GPL-2.0-or-later

import binaryen from "binaryen";

// Binaryen's JavaScript IR accessors operate directly on the compiler's expressions.
const children = new Map([
  ["Block", [], [["Children", "Child"]]],
  ["If", ["Condition", "IfTrue", "IfFalse"], []],
  ["Loop", ["Body"], []],
  ["Break", ["Condition", "Value"], []],
  ["Switch", ["Condition", "Value"], []],
  ["Call", [], [["Operands", "Operand"]]],
  ["CallIndirect", ["Target"], [["Operands", "Operand"]]],
  ["LocalSet", ["Value"], []],
  ["GlobalSet", ["Value"], []],
  ["Load", ["Ptr"], []],
  ["Store", ["Ptr", "Value"], []],
  ["Unary", ["Value"], []],
  ["Binary", ["Left", "Right"], []],
  ["Select", ["Condition", "IfTrue", "IfFalse"], []],
  ["Drop", ["Value"], []],
  ["Return", ["Value"], []],
  ["MemoryGrow", ["Delta"], []],
  ["MemoryInit", ["Dest", "Offset", "Size"], []],
  ["MemoryCopy", ["Dest", "Source", "Size"], []],
  ["MemoryFill", ["Dest", "Value", "Size"], []],
  ["Try", ["Body"], [["CatchBodies", "CatchBody"]]],
  ["Throw", [], [["Operands", "Operand"]]],
  ["CallRef", ["Target"], [["Operands", "Operand"]]],
  ["TupleMake", [], [["Operands", "Operand"]]],
  ["TupleExtract", ["Tuple"], []],
].map(([name, single, multiple]) => [binaryen[`${name}Id`], { api: binaryen[name], single, multiple }]));

/** Fold scalar operand-table reads whose complete byte range is explicitly immutable. */
export function foldReadOnlyLoads(module, memory, ranges) {
  const data = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
  let folded = 0;
  function rewrite(expression) {
    if (!expression) return expression;
    const id = binaryen.Expression.getId(expression);
    const schema = children.get(id);
    if (schema) {
      for (const field of schema.single) {
        const child = schema.api[`get${field}`](expression);
        const replacement = rewrite(child);
        if (replacement !== child) schema.api[`set${field}`](expression, replacement);
      }
      for (const [plural, field] of schema.multiple) {
        const count = schema.api[`getNum${plural}`](expression);
        for (let index = 0; index < count; ++index) {
          const child = schema.api[`get${field}At`](expression, index);
          const replacement = rewrite(child);
          if (replacement !== child) schema.api[`set${field}At`](expression, index, replacement);
        }
      }
    }
    if (id !== binaryen.LoadId || binaryen.Expression.getType(expression) !== binaryen.i32 ||
        binaryen.Load.isAtomic(expression)) return expression;
    const pointer = binaryen.Load.getPtr(expression);
    if (binaryen.Expression.getId(pointer) !== binaryen.ConstId ||
        binaryen.Expression.getType(pointer) !== binaryen.i32) return expression;
    const address = (binaryen.Const.getValueI32(pointer) >>> 0) + binaryen.Load.getOffset(expression);
    const bytes = binaryen.Load.getBytes(expression);
    if (address + bytes > memory.byteLength ||
        !ranges.some(([start, size]) => address >= start && address + bytes <= start + size)) {
      return expression;
    }
    const signed = binaryen.Load.isSigned(expression);
    let value;
    if (bytes === 1) value = signed ? data.getInt8(address) : data.getUint8(address);
    else if (bytes === 2) value = signed ? data.getInt16(address, true) : data.getUint16(address, true);
    else if (bytes === 4) value = data.getInt32(address, true);
    else return expression;
    ++folded;
    return module.i32.const(value);
  }
  for (let index = 0; index < module.getNumFunctions(); ++index) {
    const func = module.getFunctionByIndex(index);
    const body = binaryen.Function.getBody(func);
    if (body) binaryen.Function.setBody(func, rewrite(body));
  }
  return folded;
}
