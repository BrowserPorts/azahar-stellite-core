// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import binaryen from "binaryen";
import { compileFamily } from "./compiler";
import { packFamilies, type FamilyMetadata } from "./family-archive";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("DSP template and family archive paths are required");
const templates = Uint8Array.from(await readFile(input));
const module = binaryen.readBinary(templates);
try {
  const anchor = binaryen.getExportInfo(module.getExport("azahar_dsp_template_anchor"));
  const initializer = binaryen.getExpressionInfo(binaryen.getGlobalInfo(module.getGlobal(anchor.value)).init);
  if (initializer.id !== binaryen.ConstId || initializer.type !== binaryen.i32) {
    throw new Error("DSP template data anchor is not a constant");
  }
  const tableAnchor = binaryen.getExportInfo(module.getExport("azahar_dsp_template_table_anchor"));
  if (module.getNumElementSegments() !== 1) throw new Error("DSP templates require one function segment");
  const segment = binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(0));
  const tableAnchorOffset = segment.data.indexOf(tableAnchor.value);
  if (tableAnchorOffset < 0) throw new Error("DSP template table anchor is absent");
  const memory = module.getMemoryInfo();
  if (memory.base !== "memory") throw new Error("Unexpected DSP template memory import");
  const metadata: FamilyMetadata = {
    sourceSha256: createHash("sha256").update(templates).digest("hex"),
    anchorOffset: (initializer as binaryen.ConstInfo).value as number,
    tableAnchorOffset,
    shared: memory.shared,
    families: [],
  };
  const families: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const signature = binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32]);
  for (const target of segment.data) {
    const fn = binaryen.getFunctionInfo(module.getFunction(target));
    if (fn.params !== signature || fn.results !== binaryen.none) {
      metadata.families.push(null);
      continue;
    }
    const family = compileFamily(templates, target);
    metadata.families.push([offset, family.byteLength]);
    families.push(family);
    offset += family.byteLength;
  }
  const archive = packFamilies(metadata, families);
  await writeFile(output, archive);
  console.log(`DSP compiler: ${families.length} opcode families, ${archive.byteLength} archive bytes`);
} finally { module.dispose(); }
