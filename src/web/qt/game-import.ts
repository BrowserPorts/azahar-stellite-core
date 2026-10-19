// SPDX-License-Identifier: GPL-2.0-or-later

interface ImportStatus {
  progress: number;
  done: boolean;
  path: string;
  error: string;
}

/** Import a selected local game without copying its contents into the Wasm heap. */
export class GameImporter {
  #operation: { controller: AbortController; status: ImportStatus } | undefined;

  begin(accept: string): boolean {
    if (this.#operation) return false;
    const controller = new AbortController();
    const status: ImportStatus = { progress: -1, done: false, path: "", error: "" };
    this.#operation = { controller, status };
    let name = "";
    this.#select(accept, controller.signal).then(async file => {
      if (file) {
        name = file.name;
        status.path = await this.#copy(file, controller.signal, status);
      }
    }).catch(error => {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        status.error = name ? `Could not import ${name}: ${detail}` : detail;
      }
    }).finally(() => { status.done = true; });
    return true;
  }

  status(): Readonly<ImportStatus> | undefined { return this.#operation?.status; }

  cancel(): undefined {
    this.#operation?.controller.abort();
    return undefined;
  }

  finish(): undefined {
    if (this.#operation?.status.done) this.#operation = undefined;
    return undefined;
  }

  #select(accept: string, signal: AbortSignal): Promise<File | undefined> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.hidden = true;
      const complete = (file?: File): undefined => {
        input.remove();
        signal.removeEventListener("abort", cancelled);
        resolve(file);
        return undefined;
      };
      const cancelled = (): undefined => complete();
      input.addEventListener("change", () => complete(input.files?.[0]), { once: true });
      input.addEventListener("cancel", cancelled, { once: true });
      signal.addEventListener("abort", cancelled, { once: true });
      document.body.append(input);
      try { input.click(); }
      catch (error) {
        input.remove();
        signal.removeEventListener("abort", cancelled);
        reject(error);
      }
    });
  }

  async #copy(file: File, signal: AbortSignal, status: ImportStatus): Promise<string> {
    if (!Number.isSafeInteger(file.size) || !file.size || /[/\\\0]/.test(file.name) ||
      file.name === "." || file.name === "..") throw new Error("Invalid game file name or size");
    signal.throwIfAborted();
    let directory = await navigator.storage.getDirectory();
    for (const part of ["azahar", "user", "roms"]) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    // A separate directory preserves an existing game with the same filename.
    const id = crypto.randomUUID();
    const destination = await directory.getDirectoryHandle(id, { create: true });
    try {
      const handle = await destination.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      let copied = 0;
      status.progress = 0;
      const progress = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          copied += chunk.byteLength;
          status.progress = copied / file.size;
          stream.enqueue(chunk);
        },
      });
      await file.stream().pipeThrough(progress).pipeTo(writable, { signal });
      signal.throwIfAborted();
      if ((await handle.getFile()).size !== file.size) throw new Error("Game import was incomplete");
      return `/user/roms/${id}/${file.name}`;
    } catch (error) {
      await directory.removeEntry(id, { recursive: true });
      throw error;
    }
  }
}
