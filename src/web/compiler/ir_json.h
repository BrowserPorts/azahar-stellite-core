// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once
#include <string>

namespace Dynarmic::IR {
class Block;
}

namespace Azahar::Wasm {
std::string SerializeArmBlock(const Dynarmic::IR::Block& block);
std::string EncodeJsonString(const std::string& text);
}
