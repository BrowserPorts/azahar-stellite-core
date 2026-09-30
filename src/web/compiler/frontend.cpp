// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <boost/variant.hpp>
#include "dynarmic/frontend/A32/a32_ir_emitter.h"
#include "dynarmic/frontend/A32/translate/a32_translate.h"
#include "dynarmic/frontend/A32/translate/translate_callbacks.h"
#include "dynarmic/ir/basic_block.h"
#include "dynarmic/ir/microinstruction.h"
#include "dynarmic/ir/opcodes.h"
#include "dynarmic/ir/type.h"
#include "core/arm/dynarmic/arm_tick_counts.h"

namespace {
std::string result;

const char* OpcodeName(Dynarmic::IR::Opcode opcode) {
    switch (opcode) {
#define OPCODE(name, ...) case Dynarmic::IR::Opcode::name: return #name;
#define A32OPC(name, ...) case Dynarmic::IR::Opcode::A32##name: return "A32" #name;
#define A64OPC(name, ...) case Dynarmic::IR::Opcode::A64##name: return "A64" #name;
#include "dynarmic/ir/opcodes.inc"
#undef OPCODE
#undef A32OPC
#undef A64OPC
    default: throw std::runtime_error("Unknown ARM IR opcode");
    }
}

std::string Quote(const std::string& text) {
    std::string quoted = "\"";
    for (const unsigned char character : text) {
        if (character == '\\' || character == '"') quoted += '\\';
        if (character < 32) {
            quoted += " ";
        } else {
            quoted += static_cast<char>(character);
        }
    }
    return quoted + '"';
}

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

struct TerminalWriter final : boost::static_visitor<std::string> {
    TerminalWriter() = default;
    std::string operator()(const Dynarmic::IR::Term::Invalid&) const {
        throw std::runtime_error("Invalid ARM translation terminal");
    }
    std::string operator()(const Dynarmic::IR::Term::Interpret&) const {
        throw std::runtime_error("ARM instruction needs a missing JIT translation");
    }
    std::string operator()(const Dynarmic::IR::Term::ReturnToDispatch&) const {
        return "{\"kind\":\"dispatch\"}";
    }
    std::string operator()(const Dynarmic::IR::Term::PopRSBHint&) const {
        return "{\"kind\":\"dispatch\"}";
    }
    std::string operator()(const Dynarmic::IR::Term::FastDispatchHint&) const {
        return "{\"kind\":\"dispatch\"}";
    }
    template <class T>
    std::string Link(const T& terminal) const {
        const Dynarmic::A32::LocationDescriptor location(terminal.next);
        return "{\"kind\":\"link\",\"pc\":" + std::to_string(location.PC()) +
            ",\"cpsr\":" + std::to_string(location.CPSR().Value()) + "}";
    }
    std::string operator()(const Dynarmic::IR::Term::LinkBlock& terminal) const { return Link(terminal); }
    std::string operator()(const Dynarmic::IR::Term::LinkBlockFast& terminal) const { return Link(terminal); }
    std::string operator()(const Dynarmic::IR::Term::If& terminal) const {
        return "{\"kind\":\"if\",\"condition\":" + std::to_string(static_cast<int>(terminal.if_)) +
            ",\"then\":" + boost::apply_visitor(*this, terminal.then_) +
            ",\"else\":" + boost::apply_visitor(*this, terminal.else_) + "}";
    }
    std::string operator()(const Dynarmic::IR::Term::CheckBit& terminal) const {
        return "{\"kind\":\"check-bit\",\"then\":" + boost::apply_visitor(*this, terminal.then_) +
            ",\"else\":" + boost::apply_visitor(*this, terminal.else_) + "}";
    }
    std::string operator()(const Dynarmic::IR::Term::CheckHalt& terminal) const {
        return "{\"kind\":\"check-halt\",\"else\":" + boost::apply_visitor(*this, terminal.else_) + "}";
    }
};

std::string WriteBlock(const Dynarmic::IR::Block& block) {
    std::unordered_map<const Dynarmic::IR::Inst*, unsigned> names;
    unsigned index = 0;
    for (const auto& instruction : block) names.emplace(&instruction, index++);
    std::ostringstream stream;
    stream << "{\"cycles\":" << block.CycleCount() << ",\"condition\":" << static_cast<int>(block.GetCondition());
    if (block.HasConditionFailedLocation()) {
        stream << ",\"conditionFailedPc\":" << Dynarmic::A32::LocationDescriptor(block.ConditionFailedLocation()).PC()
               << ",\"conditionFailedCycles\":" << block.ConditionFailedCycleCount();
    }
    stream << ",\"terminal\":" << boost::apply_visitor(TerminalWriter{}, block.GetTerminal()) << ",\"nodes\":[";
    bool first = true;
    for (const auto& instruction : block) {
        if (!first) stream << ',';
        first = false;
        stream << "{\"op\":" << Quote(OpcodeName(instruction.GetOpcode()))
               << ",\"type\":" << Quote(Dynarmic::IR::GetNameOf(instruction.GetType())) << ",\"args\":[";
        for (size_t argument = 0; argument < instruction.NumArgs(); ++argument) {
            if (argument) stream << ',';
            const auto value = instruction.GetArg(argument);
            if (!value.IsImmediate()) {
                stream << "{\"ref\":" << names.at(value.GetInst()) << '}';
                continue;
            }
            uint64_t immediate = 0;
            switch (value.GetType()) {
            case Dynarmic::IR::Type::A32Reg: immediate = static_cast<uint64_t>(value.GetA32RegRef()); break;
            case Dynarmic::IR::Type::A32ExtReg: immediate = static_cast<uint64_t>(value.GetA32ExtRegRef()); break;
            case Dynarmic::IR::Type::Cond: immediate = static_cast<uint64_t>(value.GetCond()); break;
            case Dynarmic::IR::Type::AccType: immediate = static_cast<uint64_t>(value.GetAccType()); break;
            case Dynarmic::IR::Type::U1: case Dynarmic::IR::Type::U8: case Dynarmic::IR::Type::U16:
            case Dynarmic::IR::Type::U32: case Dynarmic::IR::Type::U64:
                immediate = value.GetImmediateAsU64(); break;
            default: throw std::runtime_error("Unsupported ARM IR immediate type");
            }
            stream << "{\"imm\":\"" << immediate << "\",\"type\":" << Quote(Dynarmic::IR::GetNameOf(value.GetType())) << '}';
        }
        stream << "]}";
    }
    stream << "]}";
    return stream.str();
}
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
        result = WriteBlock(block);
    } catch (const std::exception& error) {
        result = "{\"error\":" + Quote(error.what()) + "}";
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
