// Copyright 2026 Citra Emulator Project / Azahar Emulator Project
// Licensed under GPLv2 or any later version
// Refer to the license.txt file included.

#include <algorithm>
#include <array>
#include "audio_core/libretro_sink.h"
#include "citra_libretro/environment.h"

namespace AudioCore {

LibRetroSink::LibRetroSink(std::string) {}

LibRetroSink::~LibRetroSink() = default;

unsigned int LibRetroSink::GetNativeSampleRate() const {
    return native_sample_rate;
}

void LibRetroSink::PushSamples(const void* data, std::size_t num_samples) {
    // libretro calls stereo pairs "frames", Azahar calls them "samples"
#ifdef __EMSCRIPTEN__
    pending_samples.Push(data, num_samples);
#else
    LibRetro::SubmitAudio(static_cast<const s16*>(data), num_samples);
#endif
}

#ifdef __EMSCRIPTEN__
void LibRetroSink::Flush() {
    std::array<s16, 2048> samples;
    auto remaining = pending_samples.Size();
    while (remaining) {
        const auto frames =
            pending_samples.Pop(samples.data(), std::min(remaining, samples.size() / 2));
        LibRetro::SubmitAudio(samples.data(), frames);
        remaining -= frames;
    }
}
#endif

std::vector<std::string> ListLibretroSinkDevices() {
    return std::vector<std::string>{"LibRetro"};
}

} // namespace AudioCore
