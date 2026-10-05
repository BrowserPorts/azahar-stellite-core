// SPDX-License-Identifier: GPL-2.0-or-later

export class Bytes {
  readonly data: number[] = [];

  byte(value: number): this {
    this.data.push(value & 255);
    return this;
  }

  append(values: Iterable<number>): this {
    for (const value of values) this.byte(value);
    return this;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError("Invalid unsigned Wasm integer");
    }
    let remaining = value >>> 0;
    do {
      const next = remaining & 127;
      remaining >>>= 7;
      this.byte(next | (remaining ? 128 : 0));
    } while (remaining);
    return this;
  }

  i32(value: number): this {
    if (!Number.isInteger(value)) throw new RangeError("Invalid signed Wasm integer");
    let remaining = value | 0;
    let more = true;
    while (more) {
      const next = remaining & 127;
      remaining >>= 7;
      more = !((remaining === 0 && (next & 64) === 0) ||
        (remaining === -1 && (next & 64) !== 0));
      this.byte(next | (more ? 128 : 0));
    }
    return this;
  }

  signed(value: bigint, bits: 32 | 64): this {
    let remaining = BigInt.asIntN(bits, value);
    let more = true;
    while (more) {
      const next = Number(remaining & 127n);
      remaining >>= 7n;
      more = !((remaining === 0n && (next & 64) === 0) ||
        (remaining === -1n && (next & 64) !== 0));
      this.byte(next | (more ? 128 : 0));
    }
    return this;
  }

  name(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u32(encoded.length).append(encoded);
  }

  section(id: number, body: Bytes): this {
    return this.byte(id).u32(body.data.length).append(body.data);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.data);
  }
}

export const Type = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b } as const;
export type ValueType = keyof typeof Type;

export interface FunctionType {
  params: ValueType[];
  results: ValueType[];
}

export interface FunctionImport {
  module: string;
  name: string;
  type: FunctionType;
}

export interface ModuleOptions {
  /** Optional function label in the Wasm name section. */
  name?: string;
  imports?: FunctionImport[];
  shared: boolean;
  maximumPages: number;
  signature: FunctionType;
  locals: ValueType[];
  body: Bytes;
  table?: boolean;
  functions?: readonly { name?: string; signature?: FunctionType; locals: ValueType[]; body: Bytes }[];
}

/** All generated regions share the emulator heap and export one Wasm entry. */
export function regionModule(options: ModuleOptions): Uint8Array<ArrayBuffer> {
  const module = new Bytes().append([0, 97, 115, 109, 1, 0, 0, 0]);
  const imports = options.imports ?? [];
  const functions = options.functions ?? [options];
  // The region entry has type zero, including when referenced by a tail call.
  const types = [options.signature, ...imports.map((item) => item.type)];
  const functionTypes = functions.map(definition => {
    const signature = definition.signature;
    if (!signature || signature === options.signature) return 0;
    const index = types.findIndex(type => type.params.length === signature.params.length &&
      type.results.length === signature.results.length &&
      type.params.every((param, index) => param === signature.params[index]) &&
      type.results.every((result, index) => result === signature.results[index]));
    if (index >= 0) return index;
    types.push(signature);
    return types.length - 1;
  });
  const typeSection = new Bytes().u32(types.length);
  for (const type of types) {
    typeSection.byte(0x60).u32(type.params.length);
    for (const param of type.params) typeSection.byte(Type[param]);
    typeSection.u32(type.results.length);
    for (const result of type.results) typeSection.byte(Type[result]);
  }
  module.section(1, typeSection);
  const importSection = new Bytes().u32(imports.length + 1 + (options.table ? 1 : 0));
  imports.forEach((item, index) => {
    importSection.name(item.module).name(item.name).byte(0).u32(index + 1);
  });
  importSection.name("env").name("memory").byte(2)
    .byte(options.shared ? 3 : 1).u32(0).u32(options.maximumPages);
  if (options.table) {
    importSection.name("env").name("__indirect_function_table").byte(1).byte(0x70).byte(0).u32(0);
  }
  module.section(2, importSection);
  const declarations = new Bytes().u32(functions.length);
  functionTypes.forEach(index => declarations.u32(index));
  module.section(3, declarations);
  module.section(7, new Bytes().u32(1).name("run").byte(0).u32(imports.length));
  const code = new Bytes().u32(functions.length);
  for (const definition of functions) {
    const localRuns: { type: ValueType; count: number }[] = [];
    for (const local of definition.locals) {
      const previous = localRuns[localRuns.length - 1];
      if (previous?.type === local) previous.count++;
      else localRuns.push({ type: local, count: 1 });
    }
    const body = new Bytes().u32(localRuns.length);
    for (const run of localRuns) body.u32(run.count).byte(Type[run.type]);
    body.append(definition.body.data).byte(0x0b);
    code.u32(body.data.length).append(body.data);
  }
  module.section(10, code);
  if (options.name || options.functions?.some(definition => definition.name)) {
    const namedFunctions = functions.flatMap((definition, index) => definition.name
      ? [{ index: imports.length + index, name: definition.name }] : []);
    const names = new Bytes().u32(imports.length + namedFunctions.length);
    imports.forEach((definition, index) => names.u32(index).name(`${definition.module}.${definition.name}`));
    for (const definition of namedFunctions) names.u32(definition.index).name(definition.name);
    module.section(0, new Bytes().name("name").section(1, names));
  }
  return module.finish();
}
