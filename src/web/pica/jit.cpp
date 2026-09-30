// SPDX-License-Identifier: GPL-2.0-or-later

#include <cmath>
#include <cstdlib>
#include <stdexcept>
#include <emscripten.h>
#include "common/assert.h"
#include "video_core/pica/shader_unit.h"
#include "web/pica/jit.h"

namespace {
EM_JS(u32, CompilePicaShader, (const u32* program, const u32* swizzles, u32 entry, const u32* layout), {
    try {
        if (!Module["azaharPicaHelpers"]) {
            const rawExports = new Set(Object.values(wasmExports));
            Module["azaharPicaHelpers"] = Object.fromEntries(Object.entries(Module)
                .filter(([name, value]) => name.startsWith("_WasmPica") && rawExports.has(value))
                .map(([name, value]) => [name.slice(1), value]));
        }
        return Module["azaharPicaJitHost"].compile(
            HEAPU32.slice(program >> 2, (program >> 2) + 4096),
            HEAPU32.slice(swizzles >> 2, (swizzles >> 2) + 4096), entry,
            HEAPU32.slice(layout >> 2, (layout >> 2) + 9), wasmMemory,
            wasmExports["__indirect_function_table"], Module["azaharPicaHelpers"]).slot;
    } catch (error) {
        Module["azaharPicaError"] = String(error);
        return 0;
    }
});
EM_JS(char*, PicaCompileError, (), {
    return stringToNewUTF8(Module["azaharPicaError"] || "PICA compiler host is unavailable");
});
EM_JS(void, ReleasePicaShader, (u32 slot), {
    Module["azaharPicaJitHost"].release(slot, wasmExports["__indirect_function_table"]);
});
}

extern "C" {
EMSCRIPTEN_KEEPALIVE float WasmPicaExp2(float value) { return std::exp2(value); }
EMSCRIPTEN_KEEPALIVE float WasmPicaLog2(float value) { return std::log2(value); }
EMSCRIPTEN_KEEPALIVE void WasmPicaEmit(Pica::ShaderUnit* unit) {
    ASSERT_MSG(unit->emitter_ptr, "Execute EMIT on VS");
    unit->emitter_ptr->Emit(unit->output[unit->output_bank]);
    unit->output_bank = !unit->output_bank;
}
EMSCRIPTEN_KEEPALIVE void WasmPicaSetEmit(Pica::ShaderUnit* unit, u32 value) {
    ASSERT_MSG(unit->emitter_ptr, "Execute SETEMIT on VS");
    unit->emitter_ptr->emit_state.raw = static_cast<u8>(value);
}
}

namespace Pica::Shader {
JitShader::~JitShader() { Clear(); }
void JitShader::Clear() {
    for (const auto& [entry, slot] : entries) ReleasePicaShader(slot);
    entries.clear();
}
void JitShader::Compile(const ProgramCode* program_, const SwizzleData* swizzles_) {
    Clear();
    program = *program_;
    swizzles = *swizzles_;
}
void JitShader::Prepare(u32 entry) const {
    if (entries.contains(entry)) return;
    const u32 layout[] = {
        offsetof(Uniforms, f), offsetof(Uniforms, b), offsetof(Uniforms, i),
        offsetof(ShaderUnit, input), offsetof(ShaderUnit, temporary), offsetof(ShaderUnit, output),
        offsetof(ShaderUnit, output_bank), offsetof(ShaderUnit, address_registers),
        offsetof(ShaderUnit, conditional_code),
    };
    const u32 slot = CompilePicaShader(program.data(), swizzles.data(), entry, layout);
    if (!slot) {
        char* error = PicaCompileError();
        std::string message = error;
        std::free(error);
        throw std::runtime_error(message);
    }
    try { entries.emplace(entry, slot); }
    catch (...) { ReleasePicaShader(slot); throw; }
}
void JitShader::Run(const ShaderSetup& setup, ShaderUnit& state, u32 entry) const {
    Prepare(entry);
    using ShaderEntry = void (*)(const Uniforms*, ShaderUnit*);
    reinterpret_cast<ShaderEntry>(entries.at(entry))(&setup.uniforms, &state);
}
} // namespace Pica::Shader
