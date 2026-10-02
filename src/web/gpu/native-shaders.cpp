// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstddef>
#include <string>
#include <emscripten.h>
#include "video_core/shader/generator/glsl_fs_shader_gen.h"
#include "video_core/shader/generator/glsl_shader_gen.h"

namespace {
std::string source;
constexpr Pica::Shader::Profile profile{
    .has_separable_shaders = true,
};
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE unsigned azahar_pica_shader_abi() {
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE std::size_t azahar_pica_fs_config_size() {
    return sizeof(Pica::Shader::FSConfig);
}

extern "C" EMSCRIPTEN_KEEPALIVE u64 azahar_pica_fs_config_schema() {
    return Pica::Shader::FSConfig::StructHash();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_pica_fragment_source(
    const Pica::Shader::FSConfig* config, u32 user_flags) {
    if (!config || (user_flags & ~1U)) {
        return nullptr;
    }
    Pica::Shader::UserConfig user{};
    user.raw = user_flags;
    source = "#version 450\n" + Pica::Shader::Generator::GLSL::GenerateFragmentShader(
                                   *config, user, profile,
                                   Pica::Shader::Generator::GLSL::BindingLayout::WebGPU);
    return source.c_str();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_pica_vertex_source() {
    source = "#version 450\n" +
             Pica::Shader::Generator::GLSL::GenerateTrivialVertexShader(true, true);
    return source.c_str();
}
