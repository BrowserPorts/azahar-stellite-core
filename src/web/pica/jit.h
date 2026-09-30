// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <unordered_map>
#include <nihstro/shader_bytecode.h>
#include "video_core/pica/shader_setup.h"

using nihstro::SwizzlePattern;

namespace Pica {
struct ShaderUnit;
namespace Shader {

class JitShader final {
public:
    JitShader() = default;
    ~JitShader();
    JitShader(const JitShader&) = delete;
    JitShader& operator=(const JitShader&) = delete;

    void Compile(const ProgramCode* program, const SwizzleData* swizzles);
    void Prepare(u32 entry) const;
    void Run(const ShaderSetup& setup, ShaderUnit& state, u32 entry) const;

private:
    void Clear();
    ProgramCode program{};
    SwizzleData swizzles{};
    mutable std::unordered_map<u32, u32> entries;
};

} // namespace Shader
} // namespace Pica
