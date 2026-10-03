// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdint>
#include <string>
#include <type_traits>
#include <vector>
#include <emscripten.h>
#include "decoder.h"
#include "templates.h"

extern "C" {
EMSCRIPTEN_KEEPALIVE extern const uint8_t azahar_dsp_template_anchor = 0;
EMSCRIPTEN_KEEPALIVE void azahar_dsp_template_table_anchor() {}
}

namespace {

struct ReadOnlyTable {
    uintptr_t address;
    size_t size;
};

template <typename T, typename = std::void_t<>>
struct OperandSource {
    using type = typename T::FilterResult;
};

template <typename T>
struct OperandSource<T, std::void_t<typename T::BaseType>> {
    using type = typename T::BaseType::FilterResult;
};

template <typename T, typename = std::void_t<>>
struct OperandTable {
    static void Append(std::vector<ReadOnlyTable>&) {}
};

template <typename T>
struct OperandTable<T, std::void_t<decltype(T::values)>> {
    static void Append(std::vector<ReadOnlyTable>& tables) {
        tables.push_back({reinterpret_cast<uintptr_t>(T::values), sizeof(T::values)});
    }
};

template <typename List>
struct OperandTables;

template <typename... Operands>
struct OperandTables<OperandList<Operands...>> {
    static std::vector<ReadOnlyTable> Get() {
        std::vector<ReadOnlyTable> result;
        (OperandTable<typename OperandSource<Operands>::type>::Append(result), ...);
        return result;
    }
};

struct OpcodeTemplate {
    using Entry = void (*)(Web::Dsp::Semantics&, u16, u16);
    const char* name;
    u16 mask;
    u16 expected;
    bool expanded;
    Entry entry;
    std::vector<Rejector> rejectors;
    std::vector<ReadOnlyTable> tables;

    OpcodeTemplate Except(Rejector rejector) const {
        OpcodeTemplate result(*this);
        result.rejectors.push_back(rejector);
        return result;
    }
};

template <typename V, u16 expected, typename... Operands>
struct TemplateCreator {
    static_assert(std::is_same_v<V, Web::Dsp::Semantics>);
    using matcher_type = OpcodeTemplate;
    using F = typename VisitorFunction<V, Operands...>::type;

    template <F func>
    static void Invoke(V& cpu, u16 opcode, u16 expansion) {
        using Bound = typename MatcherCreator<V, expected, Operands...>::template BoundProxy<
            func, typename FilterOperand<Operands...>::result>;
        Bound{}(cpu, opcode, expansion);
    }

    template <F func>
    static OpcodeTemplate Create(const char* name) {
        static_assert(NoOverlap<u16, expected, Operands::Mask...>, "Overlapping DSP operands");
        constexpr u16 mask = (~Operands::Mask & ... & 0xffff);
        constexpr bool expanded = (Operands::NeedExpansion || ...);
        return {name, mask, expected, expanded, &Invoke<func>, {},
                OperandTables<typename FilterOperand<Operands...>::result>::Get()};
    }
};

const std::string& Metadata() {
    // The original decoder table supplies every opcode pattern, operand and rejection rule.
    // Each entry points to a compiled body with a fixed member function, without dispatch.
    static const auto templates = GetDecodeTable<Web::Dsp::Semantics, TemplateCreator>();
    static const std::string metadata = [] {
        std::string result = "{\"abi\":2,\"anchor\":";
        result += std::to_string(reinterpret_cast<uintptr_t>(&azahar_dsp_template_anchor));
        result += ",\"tableAnchor\":";
        result += std::to_string(reinterpret_cast<uintptr_t>(&azahar_dsp_template_table_anchor));
        result += ",\"registerSize\":";
        result += std::to_string(sizeof(Teakra::RegisterState));
        result += ",\"semanticsSize\":" + std::to_string(sizeof(Web::Dsp::Semantics));
        result += ",\"memorySize\":" + std::to_string(sizeof(Web::Dsp::MemoryAccess));
        result += ",\"templates\":[";
        bool first = true;
        for (const auto& instruction : templates) {
            if (!first) result += ',';
            first = false;
            result += "[\"";
            result += instruction.name;
            result += "\"," + std::to_string(instruction.mask);
            result += ',' + std::to_string(instruction.expected);
            result += instruction.expanded ? ",true," : ",false,";
            result += std::to_string(reinterpret_cast<uintptr_t>(instruction.entry));
            result += ",[";
            bool first_rejector = true;
            for (const auto& rejector : instruction.rejectors) {
                if (!first_rejector) result += ',';
                first_rejector = false;
                result += '[' + std::to_string(rejector.mask);
                result += ',' + std::to_string(rejector.unexpected) + ']';
            }
            result += "],[";
            bool first_table = true;
            for (const auto& table : instruction.tables) {
                if (!first_table) result += ',';
                first_table = false;
                result += '[' + std::to_string(table.address);
                result += ',' + std::to_string(table.size) + ']';
            }
            result += "]]";
        }
        result += "]}";
        return result;
    }();
    return metadata;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* azahar_dsp_template_metadata() {
    return Metadata().c_str();
}

EMSCRIPTEN_KEEPALIVE uint32_t azahar_dsp_template_metadata_size() {
    return static_cast<uint32_t>(Metadata().size());
}

}
