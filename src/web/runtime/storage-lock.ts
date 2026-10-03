// SPDX-License-Identifier: GPL-2.0-or-later

/** Serializes access to the persistent emulated SD card and NAND. */
export class UserStorageLock {
  private constructor(private readonly release: () => unknown) {}

  static acquire(): Promise<UserStorageLock> {
    return new Promise((resolve, reject) => {
      const request = navigator.locks.request("azahar:user", { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Azahar's user storage is open in another session");
        await new Promise((release) => resolve(new UserStorageLock(() => release(undefined))));
      });
      request.catch(reject);
    });
  }

  close(): undefined { this.release(); return undefined; }
}
