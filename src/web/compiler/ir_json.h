// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once
#include <string>
#include <functional>

namespace Dynarmic::IR {
class Block;
class Inst;
}

namespace Azahar::Wasm {
std::string SerializeArmBlock(const Dynarmic::IR::Block& block,
    const std::function<std::string(const Dynarmic::IR::Inst&)>& binding = {});
std::string EncodeJsonString(const std::string& text);
}
