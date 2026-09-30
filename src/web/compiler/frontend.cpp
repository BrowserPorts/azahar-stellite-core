// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include "ir_json.h"
#include "dynarmic/frontend/A32/a32_ir_emitter.h"
#include "dynarmic/frontend/A32/translate/a32_translate.h"
#include "dynarmic/frontend/A32/translate/translate_callbacks.h"
#include "dynarmic/ir/basic_block.h"
#include "core/arm/dynarmic/arm_tick_counts.h"

namespace {
std::string result;
struct CodeReader final : Dynarmic::A32::TranslateCallbacks {
    const uint8_t* bytes;
    uint32_t size;
    uint32_t base;
    uint32_t maximum_instructions;
    uint32_t instructions = 0;

    CodeReader(const uint8_t* bytes_, uint32_t size_, uint32_t base_, uint32_t limit)
        : bytes(bytes_), size(size_), base(base_), maximum_instructions(limit) {}

    std::optional<uint32_t> MemoryReadCode(uint32_t address) override {
        const uint32_t offset = address - base;
        if (size < 4 || offset > size - 4) return std::nullopt;
        uint32_t word;
        std::memcpy(&word, bytes + offset, sizeof(word));
        return word;
    }

    bool PreCodeReadHook(bool, uint32_t address, Dynarmic::A32::IREmitter& ir) override {
        const uint32_t offset = (address & ~3u) - base;
        if (instructions >= maximum_instructions || size < 4 || offset > size - 4) {
            ir.SetTerm(Dynarmic::IR::Term::LinkBlock(ir.current_location));
            return false;
        }
        ++instructions;
        return true;
    }

    void PreCodeTranslationHook(bool, uint32_t, Dynarmic::A32::IREmitter&) override {}

    uint64_t GetTicksForCode(bool thumb, uint32_t, uint32_t instruction) override {
        return Core::TicksForInstruction(thumb, instruction);
    }
};

} // namespace

extern "C" const char* azahar_translate(const uint8_t* bytes, uint32_t size, uint32_t pc,
                                       uint32_t cpsr, uint32_t fpscr, uint32_t limit) {
    try {
        if (!bytes || size < 4 || size > 4 * 1024 * 1024 || limit == 0 || limit > 1024 ||
            ((cpsr & 32) ? (pc & 1) : (pc & 3))) {
            throw std::runtime_error("Invalid ARM code snapshot");
        }
        CodeReader reader(bytes, size, pc & ~3u, limit);
        const Dynarmic::A32::LocationDescriptor location(pc, Dynarmic::A32::PSR(cpsr), Dynarmic::A32::FPSCR(fpscr));
        const Dynarmic::A32::TranslationOptions options{Dynarmic::A32::ArchVersion::v6K, true, true};
        const auto block = Dynarmic::A32::Translate(location, &reader, options);
        result = Azahar::Wasm::SerializeArmBlock(block);
    } catch (const std::exception& error) {
        result = "{\"error\":" + Azahar::Wasm::EncodeJsonString(error.what()) + "}";
    }
    return result.c_str();
}

extern "C" uint32_t azahar_result_size() { return static_cast<uint32_t>(result.size()); }

#ifndef __EMSCRIPTEN__
int main(int argc, char** argv) {
    if (argc < 4) return 2;
    std::vector<uint32_t> words;
    for (int i = 3; i < argc; ++i) words.push_back(static_cast<uint32_t>(std::stoul(argv[i], nullptr, 16)));
    std::cout << azahar_translate(reinterpret_cast<const uint8_t*>(words.data()), words.size() * 4,
                                  std::stoul(argv[1], nullptr, 16), std::stoul(argv[2], nullptr, 16), 0, 64) << '\n';
}
#endif
