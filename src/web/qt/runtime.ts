// SPDX-License-Identifier: GPL-2.0-or-later

import { UserStorageLock } from "../runtime/storage-lock";

let storage: UserStorageLock | undefined;

export async function initializeFrontend(): Promise<undefined> {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("Azahar requires cross-origin isolation");
  }
  if (storage) throw new Error("Qt frontend storage is already open");
  storage = await UserStorageLock.acquire();
  return undefined;
}

export function shutdownFrontend(): undefined {
  storage?.close();
  storage = undefined;
  return undefined;
}
