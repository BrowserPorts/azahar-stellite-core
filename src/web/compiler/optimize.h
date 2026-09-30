// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

namespace Dynarmic::A32 {
struct UserCallbacks;
}
namespace Dynarmic::IR {
class Block;
}

namespace Azahar::Wasm {
void OptimizeArmBlock(Dynarmic::IR::Block& block, bool eliminate_registers = true,
    bool propagate_constants = true, Dynarmic::A32::UserCallbacks* callbacks = nullptr);
}
