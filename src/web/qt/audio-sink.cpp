// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
#include <emscripten.h>
#include "web/qt/audio-sink.h"

namespace {

EM_JS(unsigned, RequestedAudioFrames, (bool reset), {
    const producer = Module["azaharQtAudioProducer"];
    if (!producer) return 0;
    if (reset) producer.clear();
    return producer.requestedFrames();
});

EM_JS(void, SubmitAudioFrames, (const s16* samples, unsigned frames, unsigned sample_rate), {
    Module["azaharQtAudioProducer"].write(
        HEAP16.subarray(samples >>> 1, (samples >>> 1) + frames * 2), sample_rate);
});

} // namespace

namespace AudioCore {

unsigned int WebAudioSink::GetNativeSampleRate() const {
    return native_sample_rate;
}

void WebAudioSink::SetCallback(std::function<void(s16*, std::size_t)> callback_) {
    callback = std::move(callback_);
}

void WebAudioSink::Flush() {
    if (!callback) return;
    std::array<s16, 4096> samples;
    const auto frames = std::min<std::size_t>(RequestedAudioFrames(first_flush), samples.size() / 2);
    if (!frames) return;
    first_flush = false;
    callback(samples.data(), frames);
    SubmitAudioFrames(samples.data(), static_cast<unsigned>(frames), native_sample_rate);
}

} // namespace AudioCore
