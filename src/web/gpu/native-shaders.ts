// SPDX-License-Identifier: GPL-2.0-or-later

interface NativeShaderModule {
  HEAPU8: Uint8Array<ArrayBufferLike>;
  UTF8ToString(pointer: number): string;
  _malloc(bytes: number): number;
  _free(pointer: number): unknown;
  _azahar_pica_shader_abi(): number;
  _azahar_pica_fs_config_size(): number;
  _azahar_pica_fs_config_schema(): bigint;
  _azahar_pica_fragment_source(configuration: number, userFlags: number): number;
  _azahar_pica_vertex_source(): number;
}

type NativeShaderFactory = (options: { onAbort(reason: unknown): unknown }) => Promise<NativeShaderModule>;

/** Runs Azahar's shader generators on the graphics worker using native FSConfig bytes. */
export class NativeShaders {
  #module: NativeShaderModule | undefined;
  #input = 0;
  readonly configurationSize: number;
  readonly configurationSchema: bigint;

  private constructor(module: NativeShaderModule) {
    if (module._azahar_pica_shader_abi() !== 1) throw new Error("Unsupported PICA shader ABI");
    this.configurationSize = module._azahar_pica_fs_config_size();
    this.configurationSchema = BigInt.asUintN(64, module._azahar_pica_fs_config_schema());
    this.#input = module._malloc(this.configurationSize);
    if (!this.#input) throw new Error("PICA shader configuration allocation failed");
    this.#module = module;
  }

  static async create(url: URL | string = new URL("./azahar-pica-shaders.mjs", import.meta.url)):
    Promise<NativeShaders> {
    const { default: factory } = await import(String(url)) as { default: NativeShaderFactory };
    let shaders: NativeShaders | undefined;
    const module = await factory({ onAbort: (reason) => {
      if (shaders) shaders.#module = undefined;
      throw new Error(`PICA shader generator stopped: ${String(reason)}`);
    } });
    shaders = new NativeShaders(module);
    return shaders;
  }

  fragment(configuration: Uint8Array<ArrayBufferLike>, userFlags = 0): string {
    const module = this.getModule();
    if (configuration.byteLength !== this.configurationSize ||
      !Number.isInteger(userFlags) || userFlags < 0 || userFlags > 1) {
      throw new Error("Invalid PICA shader configuration");
    }
    module.HEAPU8.set(configuration, this.#input);
    return this.generate(() => module._azahar_pica_fragment_source(this.#input, userFlags));
  }

  vertex(): string {
    const module = this.getModule();
    return this.generate(() => module._azahar_pica_vertex_source());
  }

  private generate(run: () => number): string {
    const module = this.getModule();
    let pointer: number;
    try { pointer = run(); }
    catch (error) {
      this.#module = undefined;
      throw new Error("PICA shader generation stopped", { cause: error });
    }
    if (!pointer) throw new Error("PICA shader generation failed");
    return module.UTF8ToString(pointer);
  }

  private getModule(): NativeShaderModule {
    if (!this.#module) throw new Error("The PICA shader generator is closed");
    return this.#module;
  }

  close(): undefined {
    if (this.#module) this.#module._free(this.#input);
    this.#module = undefined;
    this.#input = 0;
    return undefined;
  }
}
