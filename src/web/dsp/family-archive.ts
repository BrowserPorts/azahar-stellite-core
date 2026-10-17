// SPDX-License-Identifier: GPL-2.0-or-later

const magic = new TextEncoder().encode("AZDSPPK2");

export interface FamilyMetadata {
  sourceSha256: string;
  anchorOffset: number;
  tableAnchorOffset: number;
  shared: boolean;
  families: ([number, number] | null)[];
}

export function packFamilies(metadata: FamilyMetadata, families: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const size = families.reduce((bytes, family) => bytes + family.byteLength, 12 + header.byteLength);
  const result = new Uint8Array(size);
  result.set(magic);
  new DataView(result.buffer).setUint32(8, header.byteLength, true);
  result.set(header, 12);
  let offset = 12 + header.byteLength;
  for (const family of families) {
    result.set(family, offset);
    offset += family.byteLength;
  }
  return result;
}

export class FamilyArchive {
  readonly metadata: FamilyMetadata;
  readonly #payload: Uint8Array<ArrayBuffer>;

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    if (bytes.byteLength < 12 || magic.some((byte, index) => bytes[index] !== byte)) {
      throw new Error("Invalid DSP family archive");
    }
    const headerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
    const payloadOffset = 12 + headerSize;
    if (payloadOffset > bytes.byteLength) throw new Error("Truncated DSP family archive");
    this.metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(12, payloadOffset))) as FamilyMetadata;
    const metadata = this.metadata;
    if (!/^[0-9a-f]{64}$/.test(metadata.sourceSha256) ||
        !Number.isSafeInteger(metadata.anchorOffset) || metadata.anchorOffset < 0 ||
        !Number.isSafeInteger(metadata.tableAnchorOffset) || metadata.tableAnchorOffset < 0 ||
        typeof metadata.shared !== "boolean" || !Array.isArray(metadata.families) ||
        metadata.tableAnchorOffset >= metadata.families.length) {
      throw new Error("Invalid DSP family metadata");
    }
    this.#payload = bytes.subarray(payloadOffset);
    for (const range of metadata.families) {
      if (range === null) continue;
      if (!Array.isArray(range) || range.length !== 2 ||
          !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) ||
          range[0] < 0 || range[1] <= 0 || range[0] + range[1] > this.#payload.byteLength) {
        throw new Error("Invalid DSP family range");
      }
    }
  }

  family(index: number): Uint8Array<ArrayBuffer> {
    const range = this.metadata.families[index];
    if (!range) throw new Error("DSP opcode family is unavailable");
    return this.#payload.subarray(range[0], range[0] + range[1]);
  }
}
