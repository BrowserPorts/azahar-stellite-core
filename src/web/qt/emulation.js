// SPDX-License-Identifier: GPL-2.0-or-later

addToLibrary({
  azahar_qt_request_surface__deps: ["$PThread"],
  azahar_qt_request_surface__sig: "ii",
  azahar_qt_request_surface__proxy: "sync",
  azahar_qt_request_surface: (thread) => {
    const worker = PThread.pthreads[thread];
    if (!worker) return 0;
    try {
      const canvas = Module["azaharQtCanvas"];
      if (!canvas) throw new Error("Qt render surface is unavailable");
      const surface = canvas.transferControlToOffscreen();
      worker.postMessage({ azaharQtSurface: surface }, [surface]);
    } catch (error) {
      worker.postMessage({ azaharQtSurfaceError: String(error) });
    }
    return 1;
  },
});
