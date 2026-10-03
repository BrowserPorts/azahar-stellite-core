// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <emscripten.h>
#include <emscripten/console.h>
#include "audio_core/audio_types.h"
#include "citra_libretro/citra_libretro.h"
#include "core/core.h"
#include "core/loader/loader.h"
#include "libretro.h"

namespace {
std::map<std::string, std::string> options;
std::array<std::int16_t, 16> buttons{};
std::array<std::array<std::int16_t, 2>, 2> sticks{};
std::array<std::int16_t, 3> pointer{};
bool initialized = false;
bool loaded = false;

EM_JS(void, VideoFrame, (const void* data, unsigned width, unsigned height, size_t pitch), {
    Module["azaharVideo"]?.(data, width, height, pitch);
});
EM_JS(void, AudioFrames, (const int16_t* data, size_t frames, unsigned sample_rate), {
    Module["azaharAudio"]?.(data, frames, sample_rate);
});
EM_JS(void, DisplayMessage, (const char* text), {
    Module["printErr"]?.(UTF8ToString(text));
});

void Log(retro_log_level level, const char* format, ...) {
    std::array<char, 4096> message{};
    va_list args;
    va_start(args, format);
    std::vsnprintf(message.data(), message.size(), format, args);
    va_end(args);
    if (level >= RETRO_LOG_WARN) {
        emscripten_console_warn(message.data());
    } else {
        emscripten_console_log(message.data());
    }
}

bool Environment(unsigned command, void* data) {
    switch (command) {
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        *static_cast<unsigned*>(data) = 2;
        return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: {
        const auto* definition = static_cast<retro_core_options_v2*>(data)->definitions;
        for (; definition->key; ++definition) {
            const auto* value = definition->default_value ? definition->default_value
                                                         : definition->values[0].value;
            if (value) options.emplace(definition->key, value);
        }
        return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        auto& variable = *static_cast<retro_variable*>(data);
        const auto value = options.find(variable.key);
        variable.value = value == options.end() ? nullptr : value->second.c_str();
        return variable.value != nullptr;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *static_cast<bool*>(data) = false;
        return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *static_cast<const char**>(data) = "/user";
        return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        static_cast<retro_log_callback*>(data)->log = Log;
        return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return *static_cast<retro_pixel_format*>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        *static_cast<bool*>(data) = true;
        return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE:
        DisplayMessage(static_cast<retro_message*>(data)->msg);
        return true;
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
        return true;
    default:
        return false;
    }
}

size_t Audio(const int16_t* data, size_t frames) {
    AudioFrames(data, frames, AudioCore::native_sample_rate);
    return frames;
}
void PollInput() {}
int16_t ReadInput(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port != 0) return 0;
    if (device == RETRO_DEVICE_JOYPAD && id < buttons.size()) return buttons[id];
    if (device == RETRO_DEVICE_ANALOG && index < sticks.size() && id < 2) {
        return sticks[index][id];
    }
    if (device == RETRO_DEVICE_POINTER && index == 0 && id < pointer.size()) return pointer[id];
    return 0;
}
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE std::uint32_t azahar_web_abi() {
    return 3;
}

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_initialize() {
    if (initialized) return false;
    retro_set_environment(Environment);
    retro_set_video_refresh(VideoFrame);
    retro_set_audio_sample_batch(Audio);
    retro_set_input_poll(PollInput);
    retro_set_input_state(ReadInput);
    retro_init();
    initialized = true;
    return true;
}

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_load_game(const char* path) {
    if (!initialized || loaded || !path) return false;
    const retro_game_info game{path, nullptr, 0, nullptr};
    loaded = retro_load_game(&game);
    return loaded;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_program_id() {
    static std::array<char, 17> text{};
    std::uint64_t id = 0;
    if (loaded) Core::System::GetInstance().GetAppLoader().ReadProgramId(id);
    std::snprintf(text.data(), text.size(), "%016llx", static_cast<unsigned long long>(id));
    return text.data();
}

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_run_frame() {
    if (!initialized || !loaded) return false;
    return LibRetro::RunFrame();
}

extern "C" EMSCRIPTEN_KEEPALIVE const double* azahar_performance_stats() {
    if (!initialized || !loaded) return nullptr;
    const auto stats = Core::System::GetInstance().GetAndResetPerfStats();
    static std::array<double, 9> values{};
    values = {stats.system_fps, stats.game_fps, stats.emulation_speed,
              stats.time_vblank_interval, stats.time_hle_svc, stats.time_hle_ipc,
              stats.time_gpu, stats.time_swap, stats.time_remaining};
    return values.data();
}

extern "C" EMSCRIPTEN_KEEPALIVE void azahar_set_input(unsigned mask, int lx, int ly,
                                                     int rx, int ry, int x, int y, bool touch) {
    for (unsigned i = 0; i < buttons.size(); ++i) buttons[i] = (mask >> i) & 1;
    sticks = {{{static_cast<int16_t>(lx), static_cast<int16_t>(ly)},
               {static_cast<int16_t>(rx), static_cast<int16_t>(ry)}}};
    pointer = {static_cast<int16_t>(x), static_cast<int16_t>(y), static_cast<int16_t>(touch)};
}

extern "C" EMSCRIPTEN_KEEPALIVE void azahar_shutdown() {
    if (!initialized) return;
    if (loaded) retro_unload_game();
    retro_deinit();
    loaded = false;
    initialized = false;
    options.clear();
    buttons = {};
    sticks = {};
    pointer = {};
}
