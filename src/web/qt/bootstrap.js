// SPDX-License-Identifier: GPL-2.0-or-later

Module["azaharLazyDsp"] ??= true;

if (typeof document === "undefined") {
    self.addEventListener("message", (event) => {
        if (event.data?.azaharQtAudioTransport) {
            Module["azaharQtAudioTransport"] = event.data.azaharQtAudioTransport;
            Module["azaharQtAudioConnection"] = event.data.azaharQtAudioConnection;
            Module["azaharQtEmulation"]?.connectAudio(Module);
        }
        if (typeof event.data?.azaharQtAudioResume === "number") {
            Module["azaharQtAudioResume"] = event.data.azaharQtAudioResume;
            Module["azaharQtEmulation"]?.resumeAudio(Module);
        }
    });
}
