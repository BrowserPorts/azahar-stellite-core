// SPDX-License-Identifier: GPL-2.0-or-later

addToLibrary({
  azahar_qt_request_surface__deps: ["$PThread"],
  azahar_qt_request_surface__sig: "ii",
  azahar_qt_request_surface__proxy: "sync",
  azahar_qt_request_surface: (thread) => {
    const worker = PThread.pthreads[thread];
    if (!worker) return 0;
    try {
      const canvases = Module["azaharQtCanvases"];
      if (!canvases?.[0]) throw new Error("Qt render surface is unavailable");
      const surfaces = canvases.map(canvas => canvas.transferControlToOffscreen());
      worker.postMessage({ azaharQtSurfaces: surfaces }, surfaces);
      Module["azaharQtRuntime"].connectAudio(worker);
    } catch (error) {
      worker.postMessage({ azaharQtSurfaceError: String(error) });
    }
    return 1;
  },
  azahar_qt_release_audio__deps: ["$PThread"],
  azahar_qt_release_audio__sig: "vi",
  azahar_qt_release_audio__proxy: "sync",
  azahar_qt_release_audio: (thread) => {
    const worker = PThread.pthreads[thread];
    if (worker) Module["azaharQtRuntime"].disconnectAudio(worker);
  },
});
