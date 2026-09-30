// SPDX-License-Identifier: GPL-2.0-or-later

#include "ir_json.h"
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <boost/variant.hpp>
#include "dynarmic/frontend/A32/a32_location_descriptor.h"
#include "dynarmic/ir/basic_block.h"
#include "dynarmic/ir/microinstruction.h"
#include "dynarmic/ir/opcodes.h"
#include "dynarmic/ir/type.h"

namespace Azahar::Wasm {
namespace {
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

} // namespace

std::string EncodeJsonString(const std::string& text) {
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

std::string SerializeArmBlock(const Dynarmic::IR::Block& block,
    const std::function<std::string(const Dynarmic::IR::Inst&)>& binding) {
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
        stream << "{\"op\":" << EncodeJsonString(OpcodeName(instruction.GetOpcode()))
               << ",\"type\":" << EncodeJsonString(Dynarmic::IR::GetNameOf(instruction.GetType())) << ",\"args\":[";
        for (size_t argument = 0; argument < instruction.NumArgs(); ++argument) {
            if (argument) stream << ',';
            const auto value = instruction.GetArg(argument);
            if (!value.IsImmediate()) {
                stream << "{\"ref\":" << names.at(value.GetInst()) << '}';
                continue;
            }
            uint64_t immediate = 0;
            switch (value.GetType()) {
            case Dynarmic::IR::Type::Void: immediate = 0; break;
            case Dynarmic::IR::Type::A32Reg: immediate = static_cast<uint64_t>(value.GetA32RegRef()); break;
            case Dynarmic::IR::Type::A32ExtReg: immediate = static_cast<uint64_t>(value.GetA32ExtRegRef()); break;
            case Dynarmic::IR::Type::Cond: immediate = static_cast<uint64_t>(value.GetCond()); break;
            case Dynarmic::IR::Type::AccType: immediate = static_cast<uint64_t>(value.GetAccType()); break;
            // The register-elimination pass uses an empty NZCV immediate for a carry-only write.
            case Dynarmic::IR::Type::NZCVFlags: immediate = 0; break;
            case Dynarmic::IR::Type::U1: case Dynarmic::IR::Type::U8: case Dynarmic::IR::Type::U16:
            case Dynarmic::IR::Type::U32: case Dynarmic::IR::Type::U64:
                immediate = value.GetImmediateAsU64(); break;
            case Dynarmic::IR::Type::CoprocInfo: {
                const auto info = value.GetCoprocInfo();
                for (size_t i = 0; i < info.size(); ++i) immediate |= uint64_t(info[i]) << (i * 8);
                break;
            }
            default: throw std::runtime_error("Unsupported ARM IR immediate type");
            }
            stream << "{\"imm\":\"" << immediate << "\",\"type\":" << EncodeJsonString(Dynarmic::IR::GetNameOf(value.GetType())) << '}';
        }
        stream << ']';
        if (binding) {
            const auto value = binding(instruction);
            if (!value.empty()) stream << ",\"binding\":" << value;
        }
        stream << '}';
    }
    stream << "]}";
    return stream.str();
}
} // namespace Azahar::Wasm
