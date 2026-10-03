// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstddef>
#include <string>
#include <emscripten.h>
#include "video_core/shader/generator/glsl_fs_shader_gen.h"
#include "video_core/shader/generator/glsl_shader_gen.h"
#include "web/gpu/draw-layout.h"

namespace {
std::string source;
constexpr Pica::Shader::Profile profile{
    .has_separable_shaders = true,
};
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE unsigned azahar_pica_shader_abi() {
    return 4;
}

extern "C" EMSCRIPTEN_KEEPALIVE const u32* azahar_pica_vertex_layout() {
    static constexpr auto layout = WebGPU::DrawLayout::VertexLayout();
    return layout.data();
}

extern "C" EMSCRIPTEN_KEEPALIVE std::size_t azahar_pica_fs_config_size() {
    return sizeof(Pica::Shader::FSConfig);
}

extern "C" EMSCRIPTEN_KEEPALIVE u64 azahar_pica_fs_config_schema() {
    return Pica::Shader::FSConfig::StructHash();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_pica_fragment_source(
    const Pica::Shader::FSConfig* config, u32 user_flags) {
    const u32 depth_format = user_flags >> 4;
    if (!config || (user_flags & 15) > 9 || depth_format > 2) {
        return nullptr;
    }
    Pica::Shader::UserConfig user{};
    user.raw = user_flags & 1;
    source = "#version 450\n" + Pica::Shader::Generator::GLSL::GenerateFragmentShaderWebGPU(
                                   *config, user, profile,
                                   (user_flags >> 1) & 7,
                                   depth_format == 1 ? 16 : depth_format == 2 ? 24 : 0);
    return source.c_str();
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_pica_vertex_source() {
    source = "#version 450\n" +
             Pica::Shader::Generator::GLSL::GenerateTrivialVertexShader(true, true, true);
    return source.c_str();
}
