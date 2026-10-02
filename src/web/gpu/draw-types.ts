// SPDX-License-Identifier: GPL-2.0-or-later

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
  state: NativeDrawState;
  configuration: Uint8Array<ArrayBuffer>;
  vertices: Uint8Array<ArrayBuffer>;
  vertexUniforms: Uint8Array<ArrayBuffer>;
  fragmentUniforms: Uint8Array<ArrayBuffer>;
}
