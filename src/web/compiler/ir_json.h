// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once
#include <string>
#include <functional>
#include <cstdint>

namespace Dynarmic::IR {
class Block;
class Inst;
}

namespace Azahar::Wasm {
std::string SerializeArmBlock(const Dynarmic::IR::Block& block,
    const std::function<std::string(const Dynarmic::IR::Inst&)>& binding = {},
    bool always_little_endian = false, uint32_t source_cell = 0,
    const std::function<uint32_t(uint64_t)>& link = {});
std::string EncodeJsonString(const std::string& text);
}
