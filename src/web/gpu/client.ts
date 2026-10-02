// SPDX-License-Identifier: GPL-2.0-or-later

import type { GraphicsEvent, GraphicsRequest } from "./messages";
import { fenceByteLength, fenceErrorOffset } from "./messages";
import type { TextureRegion } from "./textures";

type Pending = { resolve(): unknown; reject(error: Error): unknown };

/** Owns the GPU worker and the synchronous fence used by native cache readbacks. */
export class GraphicsClient {
  #fence = new SharedArrayBuffer(fenceByteLength);
  #control = new Int32Array(this.#fence, 0, 3);
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #sequence = 0;
  #closed = false;
  #hasSurface = false;
  #queuedFrames = 0;
  #failure: Error | undefined;
  #reported = false;
  #ready: Promise<undefined>;
  configurationSize = 0;
  configurationSchema = 0n;

  private constructor(private readonly worker: Worker, onError: (error: Error) => unknown) {
    this.#ready = new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<GraphicsEvent>): undefined => {
        const response = event.data;
        if (response.type === "ready") {
          this.configurationSize = response.configurationSize;
          this.configurationSchema = response.configurationSchema;
          resolve(undefined);
        } else if (response.type === "presented") {
          this.#queuedFrames--;
        } else if (response.type === "reply") {
          this.#pending.get(response.id)?.resolve();
          this.#pending.delete(response.id);
        } else this.fail(new Error(response.message), reject, onError);
        return undefined;
      };
      worker.onerror = (event): undefined => this.fail(new Error(event.message), reject, onError);
      worker.onmessageerror = (): undefined => this.fail(new Error("Invalid graphics worker message"), reject, onError);
    });
  }

  static async create(onError: (error: Error) => unknown): Promise<GraphicsClient> {
    if (!globalThis.crossOriginIsolated) throw new Error("WebGPU requires cross-origin isolation");
    const worker = new Worker(new URL("./azahar-gpu-worker.js", import.meta.url), { type: "module" });
    const client = new GraphicsClient(worker, onError);
    try {
      client.post({ type: "initialize", fence: client.#fence });
      await client.#ready;
      return client;
    } catch (error) { worker.terminate(); throw error; }
  }

  async surface(canvas: OffscreenCanvas): Promise<undefined> {
    await this.request((id) => ({ type: "surface", id, canvas }), [canvas]);
    this.#hasSurface = true;
    return undefined;
  }

  present(view: Uint8Array<SharedArrayBuffer>, width: number, height: number, pitch: number): boolean {
    this.checkOpen();
    if (!this.#hasSurface) return false;
    // Presentation can drop old frames without dropping native rasterizer commands.
    if (this.#queuedFrames >= 2) return true;
    // The native framebuffer can change as soon as the callback returns.
    const bytes = view.slice();
    this.post({ type: "video", bytes, width, height, pitch }, [bytes.buffer]);
    this.#queuedFrames++;
    return true;
  }

  finish(): undefined {
    return this.synchronize((sequence) => ({ type: "finish", sequence }));
  }

  createTexture(handle: number, width: number, height: number, levels: number, layers: number,
    format: number): undefined {
    return this.post({ type: "texture-create", handle, width, height, levels, layers, format });
  }

  destroyTexture(handle: number): undefined {
    return this.post({ type: "texture-destroy", handle });
  }

  clearTexture(handle: number, region: TextureRegion, value: readonly number[], stencil = 0): undefined {
    return this.post({ type: "texture-clear", handle, region, value, stencil });
  }

  uploadTexture(handle: number, region: TextureRegion, view: Uint8Array<SharedArrayBuffer>): undefined {
    this.checkOpen();
    const bytes = view.slice();
    return this.post({ type: "texture-upload", handle, region, bytes }, [bytes.buffer]);
  }

  downloadTexture(handle: number, region: TextureRegion,
    destination: Uint8Array<SharedArrayBuffer>): undefined {
    return this.synchronize((sequence) => ({ type: "texture-download", handle, region, destination, sequence }));
  }

  private synchronize(build: (sequence: number) => GraphicsRequest): undefined {
    this.checkOpen();
    const previous = this.#sequence;
    this.#sequence = (previous + 1) | 0;
    this.post(build(this.#sequence));
    const deadline = performance.now() + 60000;
    while (Atomics.load(this.#control, 0) !== this.#sequence) {
      this.checkOpen();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        this.#failure = new Error("WebGPU did not complete the native graphics fence");
        throw this.#failure;
      }
      Atomics.wait(this.#control, 0, previous, remaining);
    }
    this.checkOpen();
    return undefined;
  }

  async close(): Promise<undefined> {
    if (this.#closed) return undefined;
    try { if (!this.#failure) await this.request((id) => ({ type: "close", id })); }
    finally {
      this.#closed = true;
      this.worker.terminate();
      for (const pending of this.#pending.values()) pending.reject(new Error("The graphics worker is closed"));
      this.#pending.clear();
    }
    return undefined;
  }

  private request(build: (id: number) => GraphicsRequest, transfer: Transferable[] = []): Promise<undefined> {
    this.checkOpen();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: () => resolve(undefined), reject });
      try { this.post(build(id), transfer); }
      catch (error) { this.#pending.delete(id); reject(error); }
    });
  }

  private post(request: GraphicsRequest, transfer: Transferable[] = []): undefined {
    this.checkOpen();
    this.worker.postMessage(request, transfer);
    return undefined;
  }

  private checkOpen(): undefined {
    if (this.#closed) throw new Error("The graphics worker is closed");
    if (Atomics.load(this.#control, 1)) {
      const length = Atomics.load(this.#control, 2);
      this.#failure ??= new Error(new TextDecoder().decode(new Uint8Array(this.#fence, fenceErrorOffset, length)));
    }
    if (this.#failure) throw this.#failure;
    return undefined;
  }

  private fail(error: Error, rejectReady: (error: Error) => unknown,
    onError: (error: Error) => unknown): undefined {
    this.#failure ??= error;
    rejectReady(this.#failure);
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    if (!this.#reported) { this.#reported = true; onError(this.#failure); }
    return undefined;
  }
}
