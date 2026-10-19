// SPDX-License-Identifier: GPL-2.0-or-later

export type Relocation = [offset: number, operand: 0 | 1 | 2 | 3];
export type RelocationValues = [memoryBase: number, tableBase: number, opcode: number, expansion: number];

// These constants reserve five signed LEB bytes for each runtime operand.
export const relocationConstants: RelocationValues = [0x12345670, 0x12345671, 0x12345672, 0x12345673];

/** Locate operand constants in the defined-global section of a compiled family. */
export function findRelocations(bytes: Uint8Array<ArrayBuffer>): Relocation[] {
  let offset = 8;
  let limit = bytes.length;
  const byte = (): number => {
    if (offset >= limit) throw new Error("Truncated DSP Wasm family");
    return bytes[offset++]!;
  };
  const integer = (signed: boolean): number => {
    let value = 0;
    let shift = 0;
    let next;
    do {
      if (shift === 35) throw new Error("Invalid DSP Wasm integer");
      next = byte();
      value |= (next & 127) << shift;
      shift += 7;
    } while (next & 128);
    if (signed && shift < 32 && (next & 64)) value |= -1 << shift;
    return signed ? value | 0 : value >>> 0;
  };
  while (offset < bytes.length) {
    const section = byte();
    const size = integer(false);
    const end = offset + size;
    if (end > bytes.length) throw new Error("Truncated DSP Wasm section");
    if (section !== 6) { offset = end; continue; }
    limit = end;
    const count = integer(false);
    const relocations: Relocation[] = [];
    const operands = new Set<number>();
    for (let index = 0; index < count; ++index) {
      if (byte() !== 0x7f || byte() !== 0 || byte() !== 0x41) {
        throw new Error("DSP family globals must be immutable i32 constants");
      }
      const start = offset;
      const value = integer(true);
      const operand = relocationConstants.indexOf(value);
      if (operand >= 0) {
        if (offset - start !== 5 || operands.has(operand)) {
          throw new Error("Invalid DSP operand relocation");
        }
        operands.add(operand);
        relocations.push([start, operand as Relocation[1]]);
      }
      if (byte() !== 0x0b) throw new Error("Invalid DSP global initializer");
    }
    if (offset !== end) throw new Error("Invalid DSP global section size");
    return relocations;
  }
  return [];
}

/** Emit a new Wasm module with literal values while preserving section sizes and indices. */
export function specializeFamily(bytes: Uint8Array<ArrayBuffer>, relocations: readonly Relocation[],
  values: RelocationValues): Uint8Array<ArrayBuffer> {
  const result = bytes.slice();
  for (const [offset, operand] of relocations) {
    let value = values[operand] | 0;
    for (let index = 0; index < 4; ++index) {
      result[offset + index] = (value & 127) | 128;
      value >>= 7;
    }
    result[offset + 4] = value & 127;
  }
  return result;
}
