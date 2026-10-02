// SPDX-License-Identifier: GPL-2.0-or-later

export interface NativeSampler {
  magFilter: number;
  minFilter: number;
  mipFilter: number;
  wrapS: number;
  wrapT: number;
  minLod: number;
  maxLod: number;
}

export class GraphicsSamplers {
  #samplers = new Map<number, GPUSampler>();

  constructor(readonly device: GPUDevice) {}

  create(id: number, params: NativeSampler): undefined {
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || this.#samplers.has(id) ||
      !Object.values(params).every(Number.isInteger) ||
      ![params.magFilter, params.minFilter, params.mipFilter].every((value) => value === 0 || value === 1) ||
      params.wrapS < 0 || params.wrapS > 7 || params.wrapT < 0 || params.wrapT > 7 ||
      params.minLod < 0 || params.maxLod < 0 || params.minLod > 15 || params.maxLod > 15) {
      throw new Error("Invalid native sampler");
    }
    // Azahar's fragment generator implements the border color for clamp-to-border modes.
    const wrap: readonly GPUAddressMode[] = ["clamp-to-edge", "clamp-to-edge", "repeat", "mirror-repeat",
      "clamp-to-edge", "clamp-to-edge", "repeat", "repeat"];
    const filter: readonly GPUFilterMode[] = ["nearest", "linear"];
    this.#samplers.set(id, this.device.createSampler({
      label: `Azahar sampler ${id}`, addressModeU: wrap[params.wrapS]!, addressModeV: wrap[params.wrapT]!,
      magFilter: filter[params.magFilter]!, minFilter: filter[params.minFilter]!, mipmapFilter: filter[params.mipFilter]!,
      lodMinClamp: Math.min(params.minLod, params.maxLod), lodMaxClamp: params.maxLod,
    }));
    return undefined;
  }

  get(id: number): GPUSampler {
    const sampler = this.#samplers.get(id);
    if (!sampler) throw new Error(`Unknown native sampler ${id}`);
    return sampler;
  }

  destroy(id: number): undefined {
    this.get(id);
    this.#samplers.delete(id);
    return undefined;
  }

  close(): undefined {
    this.#samplers.clear();
    return undefined;
  }
}
