// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstring>
#include <string>
#include <fmt/format.h>
#include "dynarmic/common/llvm_disassemble.h"
#include "dynarmic/frontend/A32/disassembler/disassembler.h"

namespace Dynarmic::Common {

std::string DisassembleAArch32(bool thumb, u32 pc, const u8* instructions, size_t length) {
    std::string result;
    for (size_t offset = 0; offset < length;) {
        if (thumb && length - offset >= sizeof(u16)) {
            u16 first;
            std::memcpy(&first, instructions + offset, sizeof(first));
            if ((first & 0xf800) >= 0xe800 && length - offset >= 2 * sizeof(u16)) {
                u16 second;
                std::memcpy(&second, instructions + offset + sizeof(first), sizeof(second));
                result += fmt::format("{:08x} {:04x} {:04x} <Thumb32>\n", pc, first, second);
                offset += 2 * sizeof(u16);
                pc += 2 * sizeof(u16);
            } else {
                result += fmt::format("{:08x} {:04x} {}\n", pc, first, A32::DisassembleThumb16(first));
                offset += sizeof(u16);
                pc += sizeof(u16);
            }
        } else if (!thumb && length - offset >= sizeof(u32)) {
            u32 instruction;
            std::memcpy(&instruction, instructions + offset, sizeof(instruction));
            result += fmt::format("{:08x} {:08x} {}\n", pc, instruction,
                                  A32::DisassembleArm(instruction));
            offset += sizeof(u32);
            pc += sizeof(u32);
        } else {
            result += fmt::format("{:08x} {:02x} <trailing byte>\n", pc, instructions[offset]);
            ++offset;
            ++pc;
        }
    }
    return result;
}

} // namespace Dynarmic::Common
