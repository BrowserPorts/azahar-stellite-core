// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdio>
#include <span>
#include "A32/testenv.h"

namespace {
struct VfpFixture {
    uint32_t fpscr;
    uint32_t lhs;
    uint32_t rhs;
    uint32_t result;
    uint32_t status;
};

// Compile the pinned native recordings without changing any input or expected value.
constexpr VfpFixture add[] = {
#include "A32/vfp_vadd_f32.inc"
};
constexpr VfpFixture subtract[] = {
#include "A32/vfp_vsub_f32.inc"
};

bool Run(std::span<const VfpFixture> fixtures, uint32_t instruction, const char* name) {
    ArmTestEnv environment;
    environment.code_mem = {instruction, 0xeafffffe};
    Dynarmic::A32::UserConfig config{&environment};
    config.arch_version = Dynarmic::A32::ArchVersion::v6K;
    Dynarmic::A32::Jit jit{config};
    for (size_t index = 0; index < fixtures.size(); ++index) {
        const auto& fixture = fixtures[index];
        jit.SetCpsr(0x000001d0);
        jit.SetFpscr(fixture.fpscr);
        jit.Regs()[15] = 0;
        jit.ExtRegs()[2] = fixture.lhs;
        jit.ExtRegs()[4] = fixture.rhs;
        environment.ticks_left = 1;
        jit.Run();
        if (jit.ExtRegs()[0] != fixture.result || jit.Fpscr() != fixture.status) {
            std::fprintf(stderr, "%s recording %zu: result %08x/%08x, FPSCR %08x/%08x\n",
                name, index, jit.ExtRegs()[0], fixture.result, jit.Fpscr(), fixture.status);
            return false;
        }
    }
    std::printf("%s: %zu native recordings passed\n", name, fixtures.size());
    return true;
}
} // namespace

int main() {
    // VADD/VSUB S0, S2, S4; the recordings contain scalar single-precision values.
    return Run(add, 0xee310a02, "VADD.F32") && Run(subtract, 0xee310a42, "VSUB.F32") ? 0 : 1;
}
