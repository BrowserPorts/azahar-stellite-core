// SPDX-License-Identifier: GPL-2.0-or-later

// The native DrawState layout is checked in rasterizer.cpp.
export const nativeDrawStateBytes = 43 * 4;
export const nativeVertexUniformBytes = 32;
export const nativeFragmentUniformBytes = 0x530;
export const nativePicaUniformBytes = 1616;

export interface NativeDrawState {
  color: number;
  depth: number;
  colorLevel: number;
  depthLevel: number;
  cull: number;
  flipped: boolean;
  colorMask: number;
  depthWrite: boolean;
  depthCompare: number;
  stencil: boolean;
  stencilCompare: number;
  stencilFail: number;
  stencilDepthFail: number;
  stencilPass: number;
  stencilReadMask: number;
  stencilWriteMask: number;
  stencilReference: number;
  blend: boolean;
  rgbEquation: number;
  alphaEquation: number;
  rgbSource: number;
  rgbDest: number;
  alphaSource: number;
  alphaDest: number;
  blendColor: number;
  logicOp: number;
  texture0Type: number;
  textures: readonly [number, number, number];
  samplers: readonly [number, number, number];
  normal: number;
  shadow: boolean;
  viewport: readonly [number, number, number, number];
  scissor: readonly [number, number, number, number];
}

/** Snapshots of native state outlive subsequent CPU register and heap writes. */
export interface NativeDraw {
  program: number;
  picaUniforms: Uint8Array<ArrayBuffer> | undefined;
  state: NativeDrawState;
  configuration: Uint8Array<ArrayBuffer>;
  vertices: Uint8Array<ArrayBuffer>;
  vertexUniforms: Uint8Array<ArrayBuffer>;
  fragmentUniforms: Uint8Array<ArrayBuffer>;
}

/** Reads a single transferred snapshot without copying its shader or vertex payloads. */
export function unpackNativeDraw(bytes: Uint8Array<ArrayBuffer>, configurationSize: number,
  program = 0, picaUniforms?: Uint8Array<ArrayBuffer>): NativeDraw {
  const vsOffset = nativeDrawStateBytes + configurationSize;
  const fsOffset = vsOffset + nativeVertexUniformBytes;
  const vertexOffset = fsOffset + nativeFragmentUniformBytes;
  if (bytes.byteOffset % 4 || !Number.isInteger(configurationSize) || configurationSize <= 0 ||
    bytes.byteLength <= vertexOffset) throw new Error("Invalid native draw snapshot");
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 43);
  const viewport = new Int32Array(bytes.buffer, bytes.byteOffset + 35 * 4, 4);
  return {
    program, picaUniforms,
    state: {
      color: u[0]!, depth: u[1]!, colorLevel: u[2]!, depthLevel: u[3]!,
      cull: u[4]!, flipped: u[5] !== 0, colorMask: u[6]!, depthWrite: u[7] !== 0, depthCompare: u[8]!,
      stencil: u[9] !== 0, stencilCompare: u[10]!, stencilFail: u[11]!, stencilDepthFail: u[12]!,
      stencilPass: u[13]!, stencilReadMask: u[14]!, stencilWriteMask: u[15]!, stencilReference: u[16]!,
      blend: u[17] !== 0, rgbEquation: u[18]!, alphaEquation: u[19]!, rgbSource: u[20]!, rgbDest: u[21]!,
      alphaSource: u[22]!, alphaDest: u[23]!, blendColor: u[24]!, logicOp: u[25]!, texture0Type: u[26]!,
      textures: [u[27]!, u[28]!, u[29]!], samplers: [u[30]!, u[31]!, u[32]!],
      normal: u[33]!, shadow: u[34] !== 0,
      viewport: [viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!],
      scissor: [u[39]!, u[40]!, u[41]!, u[42]!],
    },
    configuration: bytes.subarray(nativeDrawStateBytes, vsOffset),
    vertexUniforms: bytes.subarray(vsOffset, fsOffset),
    fragmentUniforms: bytes.subarray(fsOffset, vertexOffset),
    vertices: bytes.subarray(vertexOffset),
  };
}
