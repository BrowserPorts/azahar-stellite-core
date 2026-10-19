// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "audio_core/sink.h"

namespace AudioCore {

class WebAudioSink final : public Sink {
public:
    unsigned int GetNativeSampleRate() const override;
    void SetCallback(std::function<void(s16*, std::size_t)> callback) override;
    void Flush();

private:
    std::function<void(s16*, std::size_t)> callback;
    bool first_flush = true;
};

} // namespace AudioCore
