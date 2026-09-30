// Copyright 2015 Citra Emulator Project
// Licensed under GPLv2 or any later version
// Refer to the license.txt file included.

#include "common/arch.h"
#if !CITRA_ARCH(wasm)
#include "video_core/shader/shader_interpreter.h"
#endif
#if CITRA_ARCH(x86_64) || CITRA_ARCH(arm64) || CITRA_ARCH(wasm)
#include "video_core/shader/shader_jit.h"
#endif
#include "video_core/shader/shader.h"

namespace Pica {

std::unique_ptr<ShaderEngine> CreateEngine([[maybe_unused]] bool use_jit) {
#if CITRA_ARCH(wasm)
    return std::make_unique<Shader::JitEngine>();
#else
#if CITRA_ARCH(x86_64) || CITRA_ARCH(arm64)
    if (use_jit) {
        return std::make_unique<Shader::JitEngine>();
    }
#endif

    return std::make_unique<Shader::InterpreterEngine>();
#endif
}

} // namespace Pica
