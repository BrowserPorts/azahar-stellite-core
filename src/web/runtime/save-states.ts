// SPDX-License-Identifier: GPL-2.0-or-later

import type { AzaharModule } from "./module";

interface SaveHead {
  version: 1;
  bank: "a" | "b";
  bytes: number;
}

const MAXIMUM_STATE_BYTES = 1024 * 1024 * 1024;

/** Native Azahar snapshots stored directly from the shared heap in a dedicated worker. */
export class OpfsSaveStates {
  private constructor(
    readonly directory: FileSystemDirectoryHandle,
    readonly game: string,
  ) {}

  static async open(game: string): Promise<OpfsSaveStates> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(game)) throw new Error("Invalid save-state game key");
    const root = await navigator.storage.getDirectory();
    const azahar = await root.getDirectoryHandle("azahar", { create: true });
    const states = await azahar.getDirectoryHandle("states", { create: true });
    return new OpfsSaveStates(await states.getDirectoryHandle(game, { create: true }), game);
  }

  async save(slot: number, core: AzaharModule): Promise<number> {
    const name = this.slotName(slot);
    return navigator.locks.request(`azahar:state:${this.game}:${slot}`, async () => {
      const head = await this.readHead(name);
      const bank = head?.bank === "a" ? "b" : "a";
      const file = await this.directory.getFileHandle(`${name}-${bank}.state`, { create: true });
      const access = await file.createSyncAccessHandle();
      let pointer = 0;
      let closed = false;
      try {
        const bytes = core._retro_serialize_size();
        if (bytes < 1 || bytes > MAXIMUM_STATE_BYTES) {
          throw new Error("Azahar could not create a save state");
        }
        pointer = core._malloc(bytes);
        if (!pointer) throw new Error("Not enough memory for the save state");
        if (!core._retro_serialize(pointer, bytes)) throw new Error("Azahar serialization failed");
        const snapshot = core.HEAPU8.subarray(pointer, pointer + bytes);
        let offset = 0;
        while (offset < bytes) {
          const written = access.write(snapshot.subarray(offset), { at: offset });
          if (written < 1) throw new Error("OPFS stopped writing the save state");
          offset += written;
        }
        access.truncate(bytes);
        access.flush();
        access.close();
        closed = true;
        core._free(pointer);
        pointer = 0;

        // Publish only after the inactive bank has been flushed. Closing a writable
        // stream atomically replaces the head, preserving the previous bank on failure.
        const marker = await this.directory.getFileHandle(`${name}.json`, { create: true });
        const writer = await marker.createWritable();
        try {
          await writer.write(JSON.stringify({ version: 1, bank, bytes } satisfies SaveHead));
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => undefined);
          throw error;
        }
        return bytes;
      } finally {
        if (pointer) core._free(pointer);
        if (!closed) access.close();
      }
    });
  }

  async load(slot: number, core: AzaharModule): Promise<number> {
    const name = this.slotName(slot);
    return navigator.locks.request(`azahar:state:${this.game}:${slot}`, async () => {
      const head = await this.readHead(name);
      if (!head) throw new Error("This save-state slot is empty");
      const file = await this.directory.getFileHandle(`${name}-${head.bank}.state`);
      const access = await file.createSyncAccessHandle();
      let pointer = 0;
      try {
        if (access.getSize() !== head.bytes) throw new Error("The save-state file is incomplete");
        pointer = core._malloc(head.bytes);
        if (!pointer) throw new Error("Not enough memory to load the save state");
        const snapshot = core.HEAPU8.subarray(pointer, pointer + head.bytes);
        let offset = 0;
        while (offset < head.bytes) {
          const read = access.read(snapshot.subarray(offset), { at: offset });
          if (read < 1) throw new Error("OPFS stopped reading the save state");
          offset += read;
        }
        if (!core._retro_unserialize(pointer, head.bytes)) {
          throw new Error("Azahar rejected the save state");
        }
        return head.bytes;
      } finally {
        if (pointer) core._free(pointer);
        access.close();
      }
    });
  }

  private slotName(slot: number): string {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 11) throw new Error("Invalid save-state slot");
    return `slot-${slot}`;
  }

  private async readHead(name: string): Promise<SaveHead | undefined> {
    let file: FileSystemFileHandle;
    try { file = await this.directory.getFileHandle(`${name}.json`); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
    const marker = await file.getFile();
    // A failed first publication may leave an empty directory entry.
    if (marker.size === 0) return undefined;
    const value = JSON.parse(await marker.text()) as Partial<SaveHead> | null;
    if (!value || value.version !== 1 || (value.bank !== "a" && value.bank !== "b") ||
      !Number.isInteger(value.bytes) || Number(value.bytes) < 1 ||
      Number(value.bytes) > MAXIMUM_STATE_BYTES) {
      throw new Error("Invalid save-state metadata");
    }
    return value as SaveHead;
  }
}
