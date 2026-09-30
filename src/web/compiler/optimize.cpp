// SPDX-License-Identifier: GPL-2.0-or-later

#include "optimize.h"
#include "dynarmic/ir/opt/passes.h"

namespace Azahar::Wasm {
void OptimizeArmBlock(Dynarmic::IR::Block& block, bool eliminate_registers,
                      bool propagate_constants, Dynarmic::A32::UserCallbacks* callbacks) {
    using namespace Dynarmic::Optimization;
    PolyfillPass(block, {});
    if (eliminate_registers) {
        A32GetSetElimination(block, {});
        DeadCodeElimination(block);
    }
    if (propagate_constants) {
        if (callbacks) A32ConstantMemoryReads(block, callbacks);
        ConstantPropagation(block);
        DeadCodeElimination(block);
    }
    IdentityRemovalPass(block);
    VerificationPass(block);
}
}
