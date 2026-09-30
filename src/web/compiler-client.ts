// SPDX-License-Identifier: GPL-2.0-or-later

import { COMPILER_PROTOCOL_VERSION, JitError, validateRequest } from "./protocol";
import type { CodeDependency, CompileRequest, CompileResponse, CompiledRegion } from "./protocol";

export interface CompilerPort extends EventTarget {
  postMessage(message: CompileRequest, transfer: Transferable[]): unknown;
}

interface Pending {
  resolve: (region: CompiledRegion) => unknown;
  reject: (error: JitError) => unknown;
  timer: ReturnType<typeof setTimeout>;
  pc: number;
  dependencies: CodeDependency[];
}

export class CompilerClient {
  readonly #pending = new Map<number, Pending>();
  #disposed = false;
  readonly #onMessage = (event: Event): undefined => {
    const value: unknown = (event as MessageEvent<unknown>).data;
    if (!value || typeof value !== "object") return undefined;
    const response = value as Partial<CompileResponse>;
    if (response.version !== COMPILER_PROTOCOL_VERSION || typeof response.id !== "number") {
      return undefined;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return undefined;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.type === "compile-error" && typeof response.message === "string") {
      pending.reject(new JitError("compile", response.message));
    } else if (
      response.type === "compiled" && response.module instanceof WebAssembly.Module &&
      response.entries instanceof Uint32Array && response.entries.length > 0 &&
      response.entries.includes(pending.pc) &&
      Number.isInteger(response.generatedBytes) && Number(response.generatedBytes) > 0 &&
      Array.isArray(response.dependencies) && response.dependencies.length === pending.dependencies.length &&
      response.dependencies.every((dependency, index) => dependency !== null &&
        typeof dependency === "object" && dependency.address === pending.dependencies[index]!.address &&
        dependency.generation === pending.dependencies[index]!.generation)
    ) {
      pending.resolve(response as CompiledRegion);
    } else {
      pending.reject(new JitError("protocol", "Invalid compiler response"));
    }
    return undefined;
  };
  readonly #onFailure = (): undefined => {
    this.dispose(new JitError("compile", "The compiler worker stopped unexpectedly"));
    return undefined;
  };

  constructor(
    readonly port: CompilerPort,
    readonly maximumPending = 32,
    readonly timeoutMilliseconds = 30_000,
  ) {
    if (!Number.isInteger(maximumPending) || maximumPending < 1 ||
      !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw new RangeError("Invalid compiler queue limits");
    }
    port.addEventListener("message", this.#onMessage);
    port.addEventListener("error", this.#onFailure);
    port.addEventListener("messageerror", this.#onFailure);
  }

  compile(request: CompileRequest): Promise<CompiledRegion> {
    validateRequest(request);
    if (this.#disposed) return Promise.reject(new JitError("disposed", "The compiler client is closed"));
    if (this.#pending.size >= this.maximumPending) {
      return Promise.reject(new JitError("capacity", "The compiler queue is full"));
    }
    if (this.#pending.has(request.id)) {
      return Promise.reject(new JitError("protocol", "Duplicate compiler request id"));
    }
    // Copy before transfer: the caller's instruction snapshot remains available for retries.
    const outbound: CompileRequest = {
      ...request,
      source: request.source.slice(0),
      layout: request.layout.slice(),
      dependencies: request.dependencies.map((dependency) => ({ ...dependency })),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new JitError("compile", "The compiler request timed out"));
      }, this.timeoutMilliseconds);
      this.#pending.set(request.id, { resolve, reject, timer, pc: request.pc,
        dependencies: request.dependencies.map((dependency) => ({ ...dependency })) });
      try {
        this.port.postMessage(outbound, [outbound.source, outbound.layout.buffer]);
      } catch (error) {
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(new JitError("compile", error instanceof Error ? error.message : String(error)));
      }
    });
  }

  dispose(reason = new JitError("disposed", "The compiler client is closed")): undefined {
    if (this.#disposed) return undefined;
    this.#disposed = true;
    this.port.removeEventListener("message", this.#onMessage);
    this.port.removeEventListener("error", this.#onFailure);
    this.port.removeEventListener("messageerror", this.#onFailure);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    return undefined;
  }
}
