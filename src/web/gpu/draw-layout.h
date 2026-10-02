// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <array>
#include <cstddef>
#include "video_core/rasterizer_accelerated.h"
#include "video_core/shader/generator/shader_gen.h"

namespace WebGPU {

class DrawLayout : public VideoCore::RasterizerAccelerated {
public:
    static constexpr std::array<u32, 25> VertexLayout() {
        using namespace Pica::Shader::Generator;
        return {sizeof(HardwareVertex),
                ATTRIBUTE_POSITION, offsetof(HardwareVertex, position), 4,
                ATTRIBUTE_COLOR, offsetof(HardwareVertex, color), 4,
                ATTRIBUTE_TEXCOORD0, offsetof(HardwareVertex, tex_coord0), 2,
                ATTRIBUTE_TEXCOORD1, offsetof(HardwareVertex, tex_coord1), 2,
                ATTRIBUTE_TEXCOORD2, offsetof(HardwareVertex, tex_coord2), 2,
                ATTRIBUTE_TEXCOORD0_W, offsetof(HardwareVertex, tex_coord0_w), 1,
                ATTRIBUTE_NORMQUAT, offsetof(HardwareVertex, normquat), 4,
                ATTRIBUTE_VIEW, offsetof(HardwareVertex, view), 3};
    }
};

} // namespace WebGPU
