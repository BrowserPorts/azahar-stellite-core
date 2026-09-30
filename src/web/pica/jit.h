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
    void Run(const ShaderSetup& setup, ShaderUnit& state, u32 entry) const {
        if (prepared_entry != entry || !prepared_slot) Prepare(entry);
        using ShaderEntry = void (*)(const Uniforms*, ShaderUnit*);
        reinterpret_cast<ShaderEntry>(prepared_slot)(&setup.uniforms, &state);
    }

private:
    void Clear();
    ProgramCode program{};
    SwizzleData swizzles{};
    mutable std::unordered_map<u32, u32> entries;
    mutable u32 prepared_entry = MAX_PROGRAM_CODE_LENGTH;
    mutable u32 prepared_slot = 0;
};

} // namespace Shader
} // namespace Pica
