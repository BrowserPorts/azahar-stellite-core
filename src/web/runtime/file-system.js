// SPDX-License-Identifier: GPL-2.0-or-later

addToLibrary({
  $azaharFileReader: null,
  $azaharReadFile__deps: ["$azaharFileReader"],
  $azaharReadFile: (file, buffer, length, offset) => {
    if (!file) return -{{{ cDefs.EBADF }}};
    if (offset < 0) return -{{{ cDefs.EINVAL }}};
    if (!length || offset >= file.size) return 0;
    try {
      azaharFileReader ??= new FileReaderSync();
      const bytes = new Uint8Array(azaharFileReader.readAsArrayBuffer(
        file.slice(offset, offset + length)));
      HEAPU8.set(bytes, buffer);
      return bytes.length;
    } catch (error) {
      return -{{{ cDefs.EIO }}};
    }
  },
  azahar_read_browser_file__sig: "ipij",
  azahar_read_browser_file__i53abi: true,
  azahar_read_browser_file__deps: ["$azaharReadFile"],
  // File objects stay on the emulation worker, including reads from native I/O threads.
  azahar_read_browser_file__proxy: "sync",
  azahar_read_browser_file: (buffer, length, offset) =>
    azaharReadFile(Module["azaharGameFile"], buffer, length, offset),
  azahar_read_import_file__sig: "ipij",
  azahar_read_import_file__i53abi: true,
  azahar_read_import_file__deps: ["$azaharReadFile"],
  azahar_read_import_file__proxy: "sync",
  azahar_read_import_file: (buffer, length, offset) =>
    azaharReadFile(Module["azaharImportFile"], buffer, length, offset),
});
