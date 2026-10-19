// SPDX-License-Identifier: GPL-2.0-or-later

interface ImportStatus {
  progress: number;
  done: boolean;
  paths: string[];
  error: string;
}

/** Import selected local files without copying their contents into the Wasm heap. */
export class GameImporter {
  #operation: { controller: AbortController; status: ImportStatus } | undefined;

  begin(accept: string, multiple: boolean): boolean {
    if (this.#operation) return false;
    const controller = new AbortController();
    const status: ImportStatus = { progress: -1, done: false, paths: [], error: "" };
    this.#operation = { controller, status };
    let name = "";
    this.#select(accept, multiple, controller.signal).then(async files => {
      if (files.length) {
        name = files.length === 1 ? files[0]!.name : `${files.length} files`;
        status.paths = await this.#copy(files, controller.signal, status);
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

  #select(accept: string, multiple: boolean, signal: AbortSignal): Promise<File[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = multiple;
      input.hidden = true;
      const complete = (files: File[] = []): undefined => {
        input.remove();
        signal.removeEventListener("abort", cancelled);
        resolve(files);
        return undefined;
      };
      const cancelled = (): undefined => complete();
      input.addEventListener("change", () => complete(Array.from(input.files ?? [])), { once: true });
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

  async #copy(files: readonly File[], signal: AbortSignal, status: ImportStatus): Promise<string[]> {
    let total = 0;
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || !file.size || /[/\\\0]/.test(file.name) ||
        file.name === "." || file.name === "..") throw new Error("Invalid file name or size");
      total += file.size;
    }
    if (!Number.isSafeInteger(total)) throw new Error("Selected files are too large");
    signal.throwIfAborted();
    let directory = await navigator.storage.getDirectory();
    for (const part of ["azahar", "user", "roms"]) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    // A separate directory preserves existing files and permits rollback of the whole import.
    const id = crypto.randomUUID();
    const destination = await directory.getDirectoryHandle(id, { create: true });
    try {
      let copied = 0;
      const paths: string[] = [];
      status.progress = 0;
      for (const file of files) {
        signal.throwIfAborted();
        // Each selected file has its own location even when two basenames match.
        const prefix = files.length > 1 ? `${paths.length}/` : "";
        const folder = prefix ?
          await destination.getDirectoryHandle(String(paths.length), { create: true }) : destination;
        const handle = await folder.getFileHandle(file.name, { create: true });
        const writable = await handle.createWritable();
        const progress = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            copied += chunk.byteLength;
            status.progress = copied / total;
            stream.enqueue(chunk);
          },
        });
        await file.stream().pipeThrough(progress).pipeTo(writable, { signal });
        signal.throwIfAborted();
        if ((await handle.getFile()).size !== file.size) throw new Error("File import was incomplete");
        signal.throwIfAborted();
        paths.push(`/user/roms/${id}/${prefix}${file.name}`);
      }
      return paths;
    } catch (error) {
      await directory.removeEntry(id, { recursive: true });
      throw error;
    }
  }
}
