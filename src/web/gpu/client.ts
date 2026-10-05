// SPDX-License-Identifier: GPL-2.0-or-later

import type { GraphicsAdapterInfo, GraphicsCommand, GraphicsEvent, GraphicsRequest } from "./messages";
import { fenceByteLength, fenceErrorOffset, graphicsProtocolVersion } from "./messages";
import type { TextureRegion } from "./textures";
import type { TextureRect } from "./blits";
import type { NativeSampler } from "./samplers";
import { nativeDrawStateBytes, nativeVertexUniformBytes, nativeFragmentUniformBytes, nativePicaUniformBytes } from "./draw-types";
import type { ScreenFrame } from "./screens";

type Pending = { resolve(): unknown; reject(error: Error): unknown };

export interface GraphicsFenceStatistics {
  waitMs: number;
  count: number;
}

export interface GraphicsStatistics {
  adapter: GraphicsAdapterInfo;
  /** Emulation worker wall time waiting for readbacks and native graphics fences. */
  fenceWaitMs: number;
  fenceCount: number;
  submittedCommands: number;
  submittedBatches: number;
  programmableDraws: number;
  indexedDraws: number;
  /** Native vertex and index payload bytes copied into draw snapshots, excluding padding. */
  vertexBytes: number;
  indexBytes: number;
  /** Interval totals by the operation that stopped the emulation worker. */
  fences: {
    textureReadback: GraphicsFenceStatistics;
    explicitFinish: GraphicsFenceStatistics;
    snapshotBackpressure: GraphicsFenceStatistics;
  };
}

/** Owns the GPU worker and the synchronous fence used by native cache readbacks. */
export class GraphicsClient {
  #fence = new SharedArrayBuffer(fenceByteLength);
  #control = new Int32Array(this.#fence, 0, 3);
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #sequence = 0;
  #commands: GraphicsCommand[] = [];
  #transfers: Transferable[] = [];
  #batchBytes = 0;
  #snapshots: Uint8Array<ArrayBuffer> | undefined;
  #snapshotBytes = 0;
  #submittedCommands = 0;
  #submittedBatches = 0;
  #programmableDraws = 0;
  #indexedDraws = 0;
  #vertexBytes = 0;
  #indexBytes = 0;
  #nextVertexProgram = 0;
  #closed = false;
  #hasSurface = false;
  // Outstanding snapshot bytes through each submitted frame.
  #queuedFrameBytes: number[] = [];
  #queuedBytes = 0;
  #failure: Error | undefined;
  #reported = false;
  #ready: Promise<undefined>;
  #adapter: GraphicsAdapterInfo | undefined;
  #fences: GraphicsStatistics["fences"] = {
    textureReadback: { waitMs: 0, count: 0 },
    explicitFinish: { waitMs: 0, count: 0 },
    snapshotBackpressure: { waitMs: 0, count: 0 },
  };
  configurationSize = 0;
  configurationSchema = 0n;

  private constructor(private readonly worker: Worker, onError: (error: Error) => unknown) {
    this.#ready = new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<GraphicsEvent>): undefined => {
        const response = event.data;
        if (response.type === "ready") {
          if (response.protocol !== graphicsProtocolVersion) {
            return this.fail(new Error("Incompatible WebGPU worker protocol"), reject, onError);
          }
          this.#adapter = response.adapter;
          this.configurationSize = response.configurationSize;
          this.configurationSchema = response.configurationSchema;
          resolve(undefined);
        } else if (response.type === "presented") {
          const completed = this.#queuedFrameBytes.shift();
          if (completed === undefined) {
            this.fail(new Error("Unexpected graphics presentation completion"), reject, onError);
          } else {
            this.#queuedBytes -= completed;
            this.#queuedFrameBytes = this.#queuedFrameBytes.map(bytes => bytes - completed);
          }
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
      client.post({ type: "initialize", fence: client.#fence, protocol: graphicsProtocolVersion });
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
    if (!this.#hasSurface) { this.flush(); return false; }
    // Presentation can drop old frames without dropping native rasterizer commands.
    if (this.#queuedFrameBytes.length >= 2) { this.flush(); return true; }
    // The native framebuffer can change as soon as the callback returns.
    const bytes = view.slice();
    this.post({ type: "video", bytes, width, height, pitch }, [bytes.buffer]);
    this.#queuedFrameBytes.push(this.#queuedBytes);
    return true;
  }

  finish(): undefined {
    return this.synchronize("explicitFinish", (sequence) => ({ type: "finish", sequence }));
  }

  takeStatistics(): GraphicsStatistics {
    this.checkOpen();
    if (!this.#adapter) throw new Error("WebGPU adapter information is unavailable");
    const fences = {
      textureReadback: { ...this.#fences.textureReadback },
      explicitFinish: { ...this.#fences.explicitFinish },
      snapshotBackpressure: { ...this.#fences.snapshotBackpressure },
    };
    let fenceWaitMs = 0, fenceCount = 0;
    for (const stats of Object.values(this.#fences)) {
      fenceWaitMs += stats.waitMs;
      fenceCount += stats.count;
      stats.waitMs = 0;
      stats.count = 0;
    }
    const submittedCommands = this.#submittedCommands, submittedBatches = this.#submittedBatches;
    const programmableDraws = this.#programmableDraws;
    const indexedDraws = this.#indexedDraws, vertexBytes = this.#vertexBytes, indexBytes = this.#indexBytes;
    this.#programmableDraws = 0;
    this.#indexedDraws = 0;
    this.#vertexBytes = 0;
    this.#indexBytes = 0;
    this.#submittedCommands = 0;
    this.#submittedBatches = 0;
    return { adapter: { ...this.#adapter }, fenceWaitMs, fenceCount, fences, submittedCommands, submittedBatches,
      programmableDraws, indexedDraws, vertexBytes, indexBytes };
  }

  screens(frame: ScreenFrame): boolean {
    this.checkOpen();
    if (!this.#hasSurface) { this.flush(); return false; }
    if (this.#queuedFrameBytes.length >= 2) { this.flush(); return true; }
    const quads = frame.quads.map(quad => ({ ...quad, vertices: quad.vertices.slice() }));
    this.post({ type: "screens", frame: { ...frame, quads } }, quads.map(quad => quad.vertices.buffer));
    this.#queuedFrameBytes.push(this.#queuedBytes);
    return true;
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

  copyTexture(source: number, dest: number, src: TextureRegion, dst: TextureRegion): undefined {
    return this.post({ type: "texture-copy", source, dest, src, dst });
  }

  blitTexture(source: number, dest: number, src: TextureRect, dst: TextureRect): undefined {
    return this.post({ type: "texture-blit", source, dest, src, dst });
  }

  generateMipmaps(handle: number): undefined {
    return this.post({ type: "texture-mipmaps", handle });
  }

  createSampler(handle: number, params: NativeSampler): undefined {
    return this.post({ type: "sampler-create", handle, params });
  }

  destroySampler(handle: number): undefined {
    return this.post({ type: "sampler-destroy", handle });
  }

  createVertexProgram(source: string, inputMask: number): number {
    const handle = ++this.#nextVertexProgram;
    if (handle > 0xffffffff) throw new Error("PICA vertex program handles exhausted");
    this.post({ type: "vertex-program-create", handle, source, inputMask });
    return handle;
  }

  destroyVertexProgram(handle: number): undefined {
    return this.post({ type: "vertex-program-destroy", handle });
  }

  draw(state: Uint8Array<SharedArrayBuffer>, configuration: Uint8Array<SharedArrayBuffer>, vertices: Uint8Array<SharedArrayBuffer>,
    vertexUniforms: Uint8Array<SharedArrayBuffer>, fragmentUniforms: Uint8Array<SharedArrayBuffer>,
    program = 0, picaUniforms?: Uint8Array<SharedArrayBuffer>, indices?: Uint8Array<SharedArrayBuffer>): undefined {
    this.checkOpen();
    if (state.byteLength !== nativeDrawStateBytes || configuration.byteLength !== this.configurationSize ||
      vertexUniforms.byteLength !== nativeVertexUniformBytes || fragmentUniforms.byteLength !== nativeFragmentUniformBytes ||
      (program !== 0 ? picaUniforms?.byteLength !== nativePicaUniformBytes : picaUniforms !== undefined) ||
      (indices && (!program || !indices.byteLength || indices.byteLength % 12))) {
      throw new Error("Invalid native draw layout");
    }
    const vsOffset = nativeDrawStateBytes + configuration.byteLength;
    const fsOffset = vsOffset + nativeVertexUniformBytes;
    const vertexOffset = fsOffset + nativeFragmentUniformBytes;
    const size = vertexOffset + vertices.byteLength;
    if (!program && this.appendTriangles(state, configuration, vertexUniforms, fragmentUniforms,
      vertices, vertexOffset)) {
      this.#vertexBytes += vertices.byteLength;
      return undefined;
    }
    // Batch storage snapshots every native input before heap and register writes resume.
    const indexOffset = size + (picaUniforms?.byteLength ?? 0);
    const snapshot = this.snapshot(indexOffset + (indices?.byteLength ?? 0));
    const bytes = snapshot.subarray(0, size);
    bytes.set(state);
    bytes.set(configuration, nativeDrawStateBytes);
    bytes.set(vertexUniforms, vsOffset);
    bytes.set(fragmentUniforms, fsOffset);
    bytes.set(vertices, vertexOffset);
    const uniforms = picaUniforms ? snapshot.subarray(size, indexOffset) : undefined;
    uniforms?.set(picaUniforms!);
    const elements = indices ? snapshot.subarray(indexOffset) : undefined;
    elements?.set(indices!);
    this.post({ type: "draw", bytes, program, ...(uniforms ? { picaUniforms: uniforms } : {}),
      ...(elements ? { indices: elements } : {}) });
    if (program) this.#programmableDraws++;
    if (indices) { this.#indexedDraws++; this.#indexBytes += indices.byteLength; }
    this.#vertexBytes += vertices.byteLength;
    return undefined;
  }

  private appendTriangles(state: Uint8Array<SharedArrayBuffer>, configuration: Uint8Array<SharedArrayBuffer>,
    vertexUniforms: Uint8Array<SharedArrayBuffer>, fragmentUniforms: Uint8Array<SharedArrayBuffer>,
    vertices: Uint8Array<SharedArrayBuffer>, vertexOffset: number): boolean {
    const previous = this.#commands[this.#commands.length - 1];
    if (previous?.type !== "draw" || previous.program || !this.#snapshots ||
      previous.bytes.buffer !== this.#snapshots.buffer || vertexOffset % 4 || vertices.byteLength % 4 ||
      !vertices.byteLength || previous.bytes.byteLength <= vertexOffset ||
      previous.bytes.byteOffset + previous.bytes.byteLength !== this.#snapshotBytes ||
      this.#snapshotBytes + vertices.byteLength > this.#snapshots.byteLength) return false;
    const header = new Uint32Array(previous.bytes.buffer, previous.bytes.byteOffset, vertexOffset / 4);
    // Feedback snapshots and shadow conversions observe each original draw boundary.
    if (header[34]) return false;
    for (const binding of [27, 28, 29, 33]) {
      const texture = header[binding];
      if (texture && (texture === header[0] || texture === header[1])) return false;
    }
    let offset = 0;
    for (const source of [state, configuration, vertexUniforms, fragmentUniforms]) {
      if (source.byteOffset % 4 || source.byteLength % 4) return false;
      const words = new Uint32Array(source.buffer, source.byteOffset, source.byteLength / 4);
      for (let i = 0; i < words.length; ++i) if (words[i] !== header[offset + i]) return false;
      offset += words.length;
    }
    // Only extend the last unsubmitted snapshot, retaining triangle order and immutable state.
    const bytes = this.snapshot(vertices.byteLength);
    bytes.set(vertices);
    previous.bytes = new Uint8Array(previous.bytes.buffer, previous.bytes.byteOffset,
      previous.bytes.byteLength + vertices.byteLength);
    if (this.#batchBytes >= 256 * 1024) this.flush();
    return true;
  }

  lookupTable(table: number, offset: number, view: Uint8Array<SharedArrayBuffer>): undefined {
    this.checkOpen();
    const bytes = this.snapshot(view.byteLength);
    bytes.set(view);
    return this.post({ type: "lookup-table", table, offset, bytes });
  }

  uploadTexture(handle: number, region: TextureRegion, view: Uint8Array<SharedArrayBuffer>): undefined {
    this.checkOpen();
    const bytes = this.snapshot(view.byteLength);
    bytes.set(view);
    return this.post({ type: "texture-upload", handle, region, bytes });
  }

  downloadTexture(handle: number, region: TextureRegion,
    destination: Uint8Array<SharedArrayBuffer>): undefined {
    return this.synchronize("textureReadback",
      (sequence) => ({ type: "texture-download", handle, region, destination, sequence }));
  }

  private synchronize(reason: keyof GraphicsStatistics["fences"],
    build: (sequence: number) => GraphicsCommand): undefined {
    this.checkOpen();
    const previous = this.#sequence;
    this.#sequence = (previous + 1) | 0;
    this.post(build(this.#sequence));
    const started = performance.now();
    const deadline = started + 60000;
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
    this.#fences[reason].waitMs += performance.now() - started;
    this.#fences[reason].count++;
    this.#queuedBytes = 0;
    // Presentation replies queued during the synchronous wait cover these bytes too.
    this.#queuedFrameBytes.fill(0);
    return undefined;
  }

  private accountBytes(bytes: number): undefined {
    // Bound immutable heap snapshots while a cold native shader is being compiled.
    if (this.#queuedBytes + bytes > 64 * 1024 * 1024) {
      this.synchronize("snapshotBackpressure", (sequence) => ({ type: "finish", sequence }));
    }
    this.#queuedBytes += bytes;
    return undefined;
  }

  private snapshot(size: number): Uint8Array<ArrayBuffer> {
    const aligned = Math.ceil(size / 4) * 4;
    if (this.#snapshots && this.#snapshotBytes + aligned > this.#snapshots.byteLength) this.flush();
    if (!this.#snapshots) {
      // Leave headroom beyond the 256 KiB flush threshold.
      const capacity = Math.max(512 * 1024, aligned);
      this.accountBytes(capacity);
      this.#snapshots = new Uint8Array(capacity);
      this.#transfers.push(this.#snapshots.buffer);
    }
    const bytes = this.#snapshots.subarray(this.#snapshotBytes, this.#snapshotBytes + size);
    this.#snapshotBytes += aligned;
    this.#batchBytes += size;
    return bytes;
  }

  async close(): Promise<undefined> {
    if (this.#closed) return undefined;
    try { if (!this.#failure) await this.request((id) => ({ type: "close", id })); }
    finally {
      this.#closed = true;
      this.worker.terminate();
      for (const pending of this.#pending.values()) pending.reject(new Error("The graphics worker is closed"));
      this.#pending.clear();
      this.#commands = [];
      this.#transfers = [];
      this.#batchBytes = 0;
      this.#snapshots = undefined;
      this.#snapshotBytes = 0;
    }
    return undefined;
  }

  private request(build: (id: number) => GraphicsCommand, transfer: Transferable[] = []): Promise<undefined> {
    this.checkOpen();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: () => resolve(undefined), reject });
      try { this.post(build(id), transfer); }
      catch (error) { this.#pending.delete(id); reject(error); }
    });
  }

  private post(request: GraphicsCommand, transfer: Transferable[] = []): undefined {
    this.checkOpen();
    this.#commands.push(request);
    this.#transfers.push(...transfer);
    for (const item of transfer) if (item instanceof ArrayBuffer) this.#batchBytes += item.byteLength;
    // Start GPU work during large frames and flush before any caller waits for a reply.
    if (this.#commands.length >= 64 || this.#batchBytes >= 256 * 1024 ||
      request.type === "initialize" || request.type === "surface" || request.type === "video" ||
      request.type === "screens" || request.type === "finish" || request.type === "texture-download" ||
      request.type === "close") this.flush();
    return undefined;
  }

  private flush(): undefined {
    this.checkOpen();
    if (!this.#commands.length) return undefined;
    this.worker.postMessage({ commands: this.#commands } satisfies GraphicsRequest, this.#transfers);
    this.#submittedCommands += this.#commands.length;
    this.#submittedBatches++;
    this.#commands = [];
    this.#transfers = [];
    this.#batchBytes = 0;
    this.#snapshots = undefined;
    this.#snapshotBytes = 0;
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
