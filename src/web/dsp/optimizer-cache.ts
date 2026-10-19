// SPDX-License-Identifier: GPL-2.0-or-later

interface OptimizedEntry {
  bytes: Uint8Array<ArrayBuffer>;
  foldedLoads: number;
}

interface CacheLookup {
  key: string | undefined;
  entry: OptimizedEntry | undefined;
  elapsedMs: number;
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Persist optimized code independently of native memory and function-table instances. */
export class DspOptimizerCache {
  readonly #tables = new Map<string, Promise<string>>();
  readonly #writes = new Set<Promise<undefined>>();
  readonly #lookups = Array.from({ length: 8 }, () => Promise.resolve());
  #nextLookup = 0;
  readonly #keys: Set<string>;

  private constructor(readonly cache: Cache, readonly origin: string, keys: readonly Request[]) {
    this.#keys = new Set(keys.map(request => request.url));
  }

  static async open(compilerUrl: string): Promise<DspOptimizerCache | undefined> {
    if (typeof caches === "undefined" || typeof location === "undefined" || location.origin === "null") {
      return undefined;
    }
    try {
      const response = await fetch(compilerUrl);
      if (!response.ok) return undefined;
      const compiler = await digest(new Uint8Array(await response.arrayBuffer()));
      const cache = await caches.open(`azahar-dsp-jit-v1-${compiler}`);
      return new DspOptimizerCache(cache, location.origin, await cache.keys());
    } catch {
      return undefined;
    }
  }

  lookup(bytes: Uint8Array<ArrayBuffer>, memory: Uint8Array,
    ranges: readonly [number, number][]): Promise<CacheLookup> {
    const lane = this.#nextLookup++ % this.#lookups.length;
    const result = this.#lookups[lane]!.then(async () => {
      const started = performance.now();
      const key = await this.key(bytes, memory, ranges);
      const entry = key ? await this.read(key) : undefined;
      return { key, entry, elapsedMs: performance.now() - started };
    });
    this.#lookups[lane] = result.then(() => undefined, () => undefined);
    return result;
  }

  async key(bytes: Uint8Array<ArrayBuffer>, memory: Uint8Array,
    ranges: readonly [number, number][]): Promise<string | undefined> {
    try {
      const description = JSON.stringify(ranges);
      let tables = this.#tables.get(description);
      if (!tables) {
        const header = new TextEncoder().encode(description);
        let length = header.byteLength;
        for (const [start, size] of ranges) {
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 ||
            start + size > memory.byteLength) return undefined;
          length += size;
        }
        const snapshot = new Uint8Array(length);
        snapshot.set(header);
        let offset = header.byteLength;
        for (const [start, size] of ranges) {
          snapshot.set(memory.subarray(start, start + size), offset);
          offset += size;
        }
        tables = digest(snapshot);
        this.#tables.set(description, tables);
      }
      const [code, constants] = await Promise.all([digest(bytes), tables]);
      return `${this.origin}/azahar/dsp-code-cache/v1/${constants}/${code}`;
    } catch {
      return undefined;
    }
  }

  async read(key: string): Promise<OptimizedEntry | undefined> {
    if (!this.#keys.has(key)) return undefined;
    try {
      const response = await this.cache.match(key);
      if (!response?.ok) return undefined;
      const folded = response.headers.get("x-azahar-folded-loads");
      const foldedLoads = Number(folded);
      if (folded === null || !Number.isSafeInteger(foldedLoads) || foldedLoads < 0 ||
        foldedLoads > 0xffffffff) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength || await digest(bytes) !== response.headers.get("x-azahar-code-sha256")) {
        return undefined;
      }
      return { bytes, foldedLoads };
    } catch {
      return undefined;
    }
  }

  store(key: string, entry: OptimizedEntry): undefined {
    // Bound pending disk work without delaying compilation or mailbox delivery.
    if (this.#writes.size >= 8) return undefined;
    const pending = this.write(key, entry);
    this.#writes.add(pending);
    pending.then(() => this.#writes.delete(pending));
    return undefined;
  }

  private async write(key: string, entry: OptimizedEntry): Promise<undefined> {
    try {
      const checksum = await digest(entry.bytes);
      await this.cache.put(key, new Response(entry.bytes, { headers: {
        "Content-Type": "application/wasm",
        "x-azahar-code-sha256": checksum,
        "x-azahar-folded-loads": String(entry.foldedLoads),
      } }));
      this.#keys.add(key);
    } catch {
      // Storage limits and eviction leave the normal compilation path available.
    }
    return undefined;
  }
}
