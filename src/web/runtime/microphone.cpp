// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstddef>
#include <cstdint>
#include <emscripten.h>
#include "libretro.h"
#include "web/runtime/microphone.h"

struct retro_microphone { bool active = false; };

namespace {

EM_JS(int, ReadMicrophoneSamples, (int16_t* samples, size_t count), {
    return Module["azaharMicrophoneRead"]?.(samples, count) ?? 0;
});
EM_JS(void, MicrophoneActive, (bool active), {
    Module["azaharMicrophoneActive"]?.(!!active);
});
EM_JS(void, MicrophoneClosed, (), {
    Module["azaharMicrophoneClosed"]?.();
});

retro_microphone_t* OpenMicrophone(const retro_microphone_params_t* params) {
    if (params && params->rate != 48000) return nullptr;
    return new retro_microphone;
}

void CloseMicrophone(retro_microphone_t* microphone) {
    if (!microphone) return;
    MicrophoneActive(false);
    MicrophoneClosed();
    delete microphone;
}

bool GetMicrophoneParams(const retro_microphone_t* microphone, retro_microphone_params_t* params) {
    if (!microphone || !params) return false;
    params->rate = 48000;
    return true;
}

bool SetMicrophoneState(retro_microphone_t* microphone, bool active) {
    if (!microphone) return false;
    microphone->active = active;
    MicrophoneActive(active);
    return true;
}

bool GetMicrophoneState(const retro_microphone_t* microphone) {
    return microphone && microphone->active;
}

int ReadMicrophone(retro_microphone_t* microphone, int16_t* samples, size_t count) {
    if (!GetMicrophoneState(microphone) || !samples || count > 4096) return -1;
    return ReadMicrophoneSamples(samples, count);
}

} // namespace

const retro_microphone_interface& Web::GetMicrophoneInterface() {
    static const retro_microphone_interface interface{
        RETRO_MICROPHONE_INTERFACE_VERSION, OpenMicrophone, CloseMicrophone,
        GetMicrophoneParams, SetMicrophoneState, GetMicrophoneState, ReadMicrophone};
    return interface;
}
