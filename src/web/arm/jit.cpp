// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <map>
#include <stdexcept>
#include <utility>
#include <vector>
#include <emscripten.h>
#include <wasm_simd128.h>
#include "../compiler/ir_json.h"
#include "../compiler/optimize.h"
#include "dynarmic/common/fp/fpcr.h"
#include "dynarmic/common/fp/fpsr.h"
#include "dynarmic/common/fp/info.h"
#include "dynarmic/common/fp/op/FPCompare.h"
#include "dynarmic/common/fp/op/FPConvert.h"
#include "dynarmic/common/fp/op/FPMulAdd.h"
#include "dynarmic/common/fp/op/FPRoundInt.h"
#include "dynarmic/common/fp/op/FPToFixed.h"
#include "dynarmic/common/fp/process_exception.h"
#include "dynarmic/common/fp/process_nan.h"
#include "dynarmic/common/fp/unpacked.h"
#include "dynarmic/frontend/A32/a32_ir_emitter.h"
#include "dynarmic/frontend/A32/a32_location_descriptor.h"
#include "dynarmic/frontend/A32/translate/a32_translate.h"
#include "dynarmic/interface/A32/a32.h"
#include "dynarmic/interface/A32/coprocessor.h"
#include "dynarmic/interface/exclusive_monitor.h"
#include "dynarmic/ir/basic_block.h"
#include "dynarmic/ir/microinstruction.h"
#include "dynarmic/ir/opcodes.h"

namespace {
struct alignas(8) ArmState {
    std::array<uint32_t, 16> registers{};
    uint32_t cpsr{};
    alignas(8) std::array<uint32_t, 64> extended_registers{};
    uint32_t fpscr{};
    uint32_t check_bit{};
    bool exclusive{};
    uint32_t exclusive_address{};
    uint64_t exclusive_value{};
    Dynarmic::A32::UserConfig* config{};
    std::atomic<uint32_t>* halt{};
};

EM_JS(uint32_t, CompileArmRegion, (const char* json, const uint32_t* layout, const uint32_t* memory_config, uint32_t* bytes), {
    try {
        if (!Module["azaharJitHelpers"]) {
            const rawExports = new Set(Object.values(wasmExports));
            Module["azaharJitHelpers"] = Object.fromEntries(Object.entries(Module)
                .filter(([name, value]) => name.startsWith("_") && typeof value === "function" && rawExports.has(value))
                .map(([name, value]) => [name.slice(1), value]));
        }
        const memory = HEAPU32.slice(memory_config >> 2, (memory_config >> 2) + 7);
        const result = Module["azaharJitHost"].compile(UTF8ToString(json),
            HEAPU32.slice(layout >> 2, (layout >> 2) + 5), wasmMemory,
            wasmExports["__indirect_function_table"], Module["azaharJitHelpers"], {
                pageTable: memory[0], ...(memory[2] ? { fastmem: memory[1] } : {}),
                pointerMaskBits: memory[3], absoluteOffset: Boolean(memory[4]),
                detectMisaligned: memory[5], boundaryOnly: Boolean(memory[6])
            });
        HEAPU32[bytes >> 2] = result.bytes;
        return result.slot;
    } catch (error) {
        Module["azaharJitError"] = String(error);
        return 0;
    }
});
EM_JS(char*, ArmCompileError, (), {
    return stringToNewUTF8(Module["azaharJitError"] || "ARM compiler host is unavailable");
});
EM_JS(void, ReleaseArmRegion, (uint32_t slot), {
    Module["azaharJitHost"].release(slot, wasmExports["__indirect_function_table"]);
});

struct CodeReader final : Dynarmic::A32::TranslateCallbacks {
    Dynarmic::A32::UserCallbacks& callbacks;
    uint32_t remaining;
    uint32_t first = 0;
    uint32_t last = 0;
    bool read = false;

    CodeReader(Dynarmic::A32::UserCallbacks& callbacks_, uint32_t limit)
        : callbacks(callbacks_), remaining(limit) {}
    std::optional<uint32_t> MemoryReadCode(uint32_t address) override {
        if (!read) first = address;
        last = address;
        read = true;
        return callbacks.MemoryReadCode(address);
    }
    bool PreCodeReadHook(bool thumb, uint32_t pc, Dynarmic::A32::IREmitter& ir) override {
        if (remaining-- == 0) {
            ir.SetTerm(Dynarmic::IR::Term::LinkBlock{ir.current_location});
            return false;
        }
        return callbacks.PreCodeReadHook(thumb, pc, ir);
    }
    void PreCodeTranslationHook(bool thumb, uint32_t pc, Dynarmic::A32::IREmitter& ir) override {
        callbacks.PreCodeTranslationHook(thumb, pc, ir);
    }
    uint64_t GetTicksForCode(bool thumb, uint32_t pc, uint32_t instruction) override {
        return callbacks.GetTicksForCode(thumb, pc, instruction);
    }
};

bool Overlaps(uint32_t a, uint64_t a_length, uint32_t b, uint64_t b_length) {
    // Circular 32-bit guest addresses also cover blocks crossing address zero.
    return a_length >= (uint64_t{1} << 32) || b_length >= (uint64_t{1} << 32) ||
        uint32_t(a - b) < b_length || uint32_t(b - a) < a_length;
}

std::string CallbackBinding(const Dynarmic::A32::Coprocessor::Callback& callback) {
    return "{\"kind\":\"callback\",\"function\":" +
        std::to_string(reinterpret_cast<uintptr_t>(callback.function)) +
        ",\"userArgument\":" + std::to_string(reinterpret_cast<uintptr_t>(callback.user_arg.value_or(nullptr))) + "}";
}

std::string AccessBinding(uint32_t* address) {
    if (!address) throw std::runtime_error("Null coprocessor register binding");
    return "{\"kind\":\"access\",\"addresses\":[" + std::to_string(reinterpret_cast<uintptr_t>(address)) + "]}";
}
std::string AccessBinding(const std::array<uint32_t*, 2>& addresses) {
    if (!addresses[0] || !addresses[1]) throw std::runtime_error("Null coprocessor register binding");
    return "{\"kind\":\"access\",\"addresses\":[" + std::to_string(reinterpret_cast<uintptr_t>(addresses[0])) +
        ',' + std::to_string(reinterpret_cast<uintptr_t>(addresses[1])) + "]}";
}
template <class T> std::string Binding(const T& value) {
    if (const auto* callback = std::get_if<Dynarmic::A32::Coprocessor::Callback>(&value)) return CallbackBinding(*callback);
    if constexpr (std::is_same_v<T, Dynarmic::A32::Coprocessor::CallbackOrAccessOneWord>) {
        if (const auto* access = std::get_if<uint32_t*>(&value)) return AccessBinding(*access);
    } else {
        if (const auto* access = std::get_if<std::array<uint32_t*, 2>>(&value)) return AccessBinding(*access);
    }
    throw std::runtime_error("Coprocessor did not provide a JIT binding");
}

std::string CoprocessorBinding(const Dynarmic::IR::Inst& instruction, Dynarmic::A32::UserConfig& config) {
    using Dynarmic::IR::Opcode;
    using Dynarmic::A32::CoprocReg;
    const auto opcode = instruction.GetOpcode();
    if (opcode != Opcode::A32CoprocGetOneWord && opcode != Opcode::A32CoprocSendOneWord &&
        opcode != Opcode::A32CoprocGetTwoWords && opcode != Opcode::A32CoprocSendTwoWords &&
        opcode != Opcode::A32CoprocInternalOperation && opcode != Opcode::A32CoprocLoadWords &&
        opcode != Opcode::A32CoprocStoreWords) return {};
    const auto info = instruction.GetArg(0).GetCoprocInfo();
    const auto& coprocessor = config.coprocessors.at(info[0]);
    if (!coprocessor) throw std::runtime_error("Guest coprocessor is unavailable");
    switch (opcode) {
    case Opcode::A32CoprocGetOneWord:
        return Binding(coprocessor->CompileGetOneWord(info[1], info[2], CoprocReg(info[3]), CoprocReg(info[4]), info[5]));
    case Opcode::A32CoprocSendOneWord:
        return Binding(coprocessor->CompileSendOneWord(info[1], info[2], CoprocReg(info[3]), CoprocReg(info[4]), info[5]));
    case Opcode::A32CoprocGetTwoWords:
        return Binding(coprocessor->CompileGetTwoWords(info[1], info[2], CoprocReg(info[3])));
    case Opcode::A32CoprocSendTwoWords:
        return Binding(coprocessor->CompileSendTwoWords(info[1], info[2], CoprocReg(info[3])));
    default: {
        const auto callback = opcode == Opcode::A32CoprocInternalOperation
            ? coprocessor->CompileInternalOperation(info[1], info[2], CoprocReg(info[3]), CoprocReg(info[4]), CoprocReg(info[5]), info[6])
            : opcode == Opcode::A32CoprocLoadWords
                ? coprocessor->CompileLoadWords(info[1], info[2], CoprocReg(info[3]), info[4] ? std::optional<uint8_t>{info[5]} : std::nullopt)
                : coprocessor->CompileStoreWords(info[1], info[2], CoprocReg(info[3]), info[4] ? std::optional<uint8_t>{info[5]} : std::nullopt);
        if (!callback) throw std::runtime_error("Coprocessor did not provide a JIT callback");
        return CallbackBinding(*callback);
    }
    }
}

template <class Bits> uint32_t CompareFP(Bits lhs, Bits rhs, bool signal_quiet_nan,
                                       Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    const auto left = FPUnpack(lhs, fpcr, fpsr);
    const auto right = FPUnpack(rhs, fpcr, fpsr);
    const auto left_type = std::get<FPType>(left);
    const auto right_type = std::get<FPType>(right);
    if (left_type == FPType::QNaN || left_type == FPType::SNaN ||
        right_type == FPType::QNaN || right_type == FPType::SNaN) {
        if (signal_quiet_nan || left_type == FPType::SNaN || right_type == FPType::SNaN) {
            FPProcessException(FPExc::InvalidOp, fpcr, fpsr);
        }
        return 0x30000000;
    }
    using Float = std::conditional_t<sizeof(Bits) == 4, float, double>;
    const Float left_value = left_type == FPType::Zero ? Float{0} : std::bit_cast<Float>(lhs);
    const Float right_value = right_type == FPType::Zero ? Float{0} : std::bit_cast<Float>(rhs);
    return left_value == right_value ? 0x60000000 : left_value < right_value ? 0x80000000 : 0x20000000;
}
void SetFPStatus(ArmState* state, const Dynarmic::FP::FPSR& fpsr) {
    state->fpscr |= fpsr.Value() & 0x9f;
}
template <class Bits> Bits VfpInput(ArmState* state, Bits value,
                                   Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using Info = Dynarmic::FP::FPInfo<Bits>;
    if (state->config->arch_version <= Dynarmic::A32::ArchVersion::v6K && fpcr.FZ() &&
        !(value & Info::exponent_mask) && (value & Info::mantissa_mask)) {
        Dynarmic::FP::FPProcessException(Dynarmic::FP::FPExc::InputDenorm, fpcr, fpsr);
        return 0;
    }
    return value;
}
template <class Bits> uint64_t ToFixed(ArmState* state, Bits value, uint32_t integer_bits,
                                     uint32_t fractional_bits, uint32_t rounding, bool unsigned_value) {
    Dynarmic::FP::FPSR fpsr{state->fpscr};
    const auto result = Dynarmic::FP::FPToFixed(integer_bits, value, fractional_bits, unsigned_value,
        Dynarmic::FP::FPCR{state->fpscr}, static_cast<Dynarmic::FP::RoundingMode>(rounding), fpsr);
    SetFPStatus(state, fpsr);
    return result;
}
template <class Operation> auto FloatingPoint(ArmState* state, Operation operation) {
    Dynarmic::FP::FPSR fpsr{};
    const Dynarmic::FP::FPCR fpcr{state->fpscr};
    auto result = operation(fpcr, fpsr);
    // VFP11 flushes underflow results to positive zero (ARM DDI 0274H, 5.9.2).
    if (state->config->arch_version <= Dynarmic::A32::ArchVersion::v6K && fpcr.FZ() && fpsr.UFC()) result = 0;
    SetFPStatus(state, fpsr);
    return result;
}
template <class Bits> Dynarmic::FP::FPUnpacked UnpackNormal(Bits value) {
    using Info = Dynarmic::FP::FPInfo<Bits>;
    return {(value & Info::sign_mask) != 0,
        static_cast<int>((value & Info::exponent_mask) >> Info::explicit_mantissa_width) - Info::exponent_bias,
        static_cast<uint64_t>((value & Info::mantissa_mask) | Info::implicit_leading_bit)
            << (Dynarmic::FP::normalized_point_position - Info::explicit_mantissa_width)};
}
template <class Bits> Bits RoundNative(Bits result, bool sign, int comparison,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    if (comparison == 0) return result;
    FPProcessException(FPExc::Inexact, fpcr, fpsr);
    const auto rounding = fpcr.RMode();
    if (rounding == RoundingMode::ToNearest_TieEven) return result;
    const bool away = (rounding == RoundingMode::TowardsPlusInfinity && !sign) ||
        (rounding == RoundingMode::TowardsMinusInfinity && sign);
    if (away && comparison < 0) ++result;
    if (!away && comparison > 0) --result;
    return result;
}
template <class Bits> Bits DivideFP(Bits lhs, Bits rhs,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    using Info = FPInfo<Bits>;
    using Wide = __uint128_t;
    const auto [left_type, left_sign, left] = FPUnpack(lhs, fpcr, fpsr);
    const auto [right_type, right_sign, right] = FPUnpack(rhs, fpcr, fpsr);
    if (const auto nan = FPProcessNaNs(left_type, right_type, lhs, rhs, fpcr, fpsr)) return *nan;
    if ((left_type == FPType::Zero && right_type == FPType::Zero) ||
        (left_type == FPType::Infinity && right_type == FPType::Infinity)) {
        FPProcessException(FPExc::InvalidOp, fpcr, fpsr);
        return Info::DefaultNaN();
    }
    const bool sign = left_sign != right_sign;
    if (left_type == FPType::Infinity) return Info::Infinity(sign);
    if (left_type == FPType::Zero || right_type == FPType::Infinity) return Info::Zero(sign);
    if (right_type == FPType::Zero) {
        FPProcessException(FPExc::DivideByZero, fpcr, fpsr);
        return Info::Infinity(sign);
    }
    using Float = std::conditional_t<sizeof(Bits) == 4, float, double>;
    const Bits result = std::bit_cast<Bits>(std::bit_cast<Float>(lhs) / std::bit_cast<Float>(rhs));
    const Bits exponent = result & Info::exponent_mask;
    const Bits binade = Bits{1} << Info::explicit_mantissa_width;
    // Boundary binades use ARM's tininess and overflow rules before rounding.
    if (exponent > binade && exponent < Info::exponent_mask - binade) {
        const auto output = UnpackNormal(result);
        const Wide rounded = Wide{output.mantissa} * right.mantissa;
        const Wide exact = Wide{left.mantissa} <<
            (normalized_point_position + left.exponent - right.exponent - output.exponent);
        return RoundNative(result, sign, (rounded > exact) - (rounded < exact), fpcr, fpsr);
    }
    const Wide numerator = Wide{left.mantissa} << normalized_point_position;
    const uint64_t quotient = static_cast<uint64_t>(numerator / right.mantissa) |
        static_cast<uint64_t>(numerator % right.mantissa != 0);
    return FPRound<Bits>({sign, left.exponent - right.exponent, quotient}, fpcr, fpsr);
}
template <class Bits> Bits SquareRootFP(Bits value,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    using Info = FPInfo<Bits>;
    using Wide = __uint128_t;
    const auto [type, sign, input] = FPUnpack(value, fpcr, fpsr);
    if (type == FPType::QNaN || type == FPType::SNaN) return FPProcessNaN(type, value, fpcr, fpsr);
    if (type == FPType::Zero) return Info::Zero(sign);
    if (sign) {
        FPProcessException(FPExc::InvalidOp, fpcr, fpsr);
        return Info::DefaultNaN();
    }
    if (type == FPType::Infinity) return value;
    using Float = std::conditional_t<sizeof(Bits) == 4, float, double>;
    const Bits result = std::bit_cast<Bits>(std::sqrt(std::bit_cast<Float>(value)));
    const auto output = UnpackNormal(result);
    // Every positive finite f32/f64 square root is normal. Compare its square
    // to the input exactly, including inputs with an odd or negative exponent.
    const int odd = input.exponent & 1;
    const int exponent = (input.exponent - odd) / 2;
    const Wide root = Wide{output.mantissa} << (output.exponent - exponent);
    const Wide rounded = root * root;
    const Wide exact = Wide{input.mantissa} << (normalized_point_position + odd);
    return RoundNative(result, false, (rounded > exact) - (rounded < exact), fpcr, fpsr);
}
template <class Bits, bool Maximum, bool Numeric> Bits SelectFP(Bits lhs, Bits rhs,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    const auto [left_type, left_sign, left] = FPUnpack(lhs, fpcr, fpsr);
    const auto [right_type, right_sign, right] = FPUnpack(rhs, fpcr, fpsr);
    if (left_type == FPType::Zero) lhs = FPInfo<Bits>::Zero(left_sign);
    if (right_type == FPType::Zero) rhs = FPInfo<Bits>::Zero(right_sign);
    if constexpr (Numeric) {
        if (left_type == FPType::QNaN && right_type != FPType::QNaN && right_type != FPType::SNaN) return rhs;
        if (right_type == FPType::QNaN && left_type != FPType::QNaN && left_type != FPType::SNaN) return lhs;
    }
    if (const auto nan = FPProcessNaNs(left_type, right_type, lhs, rhs, fpcr, fpsr)) return *nan;
    using Float = std::conditional_t<sizeof(Bits) == 4, float, double>;
    const Float left_value = std::bit_cast<Float>(lhs);
    const Float right_value = std::bit_cast<Float>(rhs);
    if (left_value == right_value) return Maximum ? lhs & rhs : lhs | rhs;
    return (Maximum ? left_value > right_value : left_value < right_value) ? lhs : rhs;
}
template <class Result, class Integer> Result ConvertFixed(Integer value,
    uint32_t fractional_bits, uint32_t rounding, Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    const bool sign = std::is_signed_v<Integer> && value < 0;
    const uint64_t magnitude = sign ? uint64_t{0} - static_cast<uint64_t>(value) : static_cast<uint64_t>(value);
    if (!magnitude) return Result{0};
    auto unpacked = magnitude >> 63
        ? Dynarmic::FP::FPUnpacked{sign, 63, (magnitude >> 1) | (magnitude & 1)}
        : Dynarmic::FP::ToNormalized(sign, 0, magnitude);
    unpacked.exponent -= fractional_bits;
    return Dynarmic::FP::FPRound<Result>(unpacked, fpcr,
        static_cast<Dynarmic::FP::RoundingMode>(rounding), fpsr);
}
Dynarmic::FP::FPCR VectorFPControl(ArmState* state, bool controlled) {
    const Dynarmic::FP::FPCR fpcr{state->fpscr};
    return controlled ? fpcr : fpcr.ASIMDStandardValue();
}
template <class Bits, class Operation, class... Vectors> v128_t VectorFP(ArmState* state,
    bool fpcr_controlled, Operation operation, Vectors... operands) {
    using Lanes = std::array<Bits, sizeof(v128_t) / sizeof(Bits)>;
    Lanes result;
    Dynarmic::FP::FPSR fpsr{};
    const auto fpcr = VectorFPControl(state, fpcr_controlled);
    for (size_t lane = 0; lane < result.size(); ++lane) {
        result[lane] = operation(std::bit_cast<Lanes>(operands)[lane]..., fpcr, fpsr);
    }
    SetFPStatus(state, fpsr);
    return std::bit_cast<v128_t>(result);
}
template <class Result, class Input> v128_t VectorConvert(ArmState* state, v128_t value,
    uint32_t rounding, bool controlled) {
    const auto input = std::bit_cast<std::array<Input, sizeof(v128_t) / sizeof(Input)>>(value);
    std::array<Result, sizeof(v128_t) / sizeof(Result)> result{};
    Dynarmic::FP::FPSR fpsr{};
    const auto fpcr = VectorFPControl(state, controlled);
    for (size_t lane = 0; lane < std::min(input.size(), result.size()); ++lane) {
        result[lane] = Dynarmic::FP::FPConvert<Result>(input[lane], fpcr,
            static_cast<Dynarmic::FP::RoundingMode>(rounding), fpsr);
    }
    SetFPStatus(state, fpsr);
    return std::bit_cast<v128_t>(result);
}
template <class Result, class Integer> Result FromFixed(ArmState* state, Integer value,
                                                       uint32_t fractional_bits, uint32_t rounding) {
    return FloatingPoint(state, [&](auto fpcr, auto& fpsr) {
        return ConvertFixed<Result>(value, fractional_bits, rounding, fpcr, fpsr);
    });
}
template <class Bits, bool Unsigned> v128_t VectorToFixed(ArmState* state, v128_t value,
    uint32_t fractional_bits, uint32_t rounding, bool fpcr_controlled) {
    using Lanes = std::array<Bits, sizeof(v128_t) / sizeof(Bits)>;
    const auto input = std::bit_cast<Lanes>(value);
    Lanes result;
    Dynarmic::FP::FPSR fpsr{};
    const auto fpcr = VectorFPControl(state, fpcr_controlled);
    for (size_t lane = 0; lane < result.size(); ++lane) {
        result[lane] = static_cast<Bits>(Dynarmic::FP::FPToFixed(sizeof(Bits) * 8,
            input[lane], fractional_bits, Unsigned, fpcr,
            static_cast<Dynarmic::FP::RoundingMode>(rounding), fpsr));
    }
    SetFPStatus(state, fpsr);
    return std::bit_cast<v128_t>(result);
}
template <class Bits, class Integer> v128_t VectorFromFixed(ArmState* state, v128_t value,
    uint32_t fractional_bits, uint32_t rounding, bool fpcr_controlled) {
    using Lanes = std::array<Bits, sizeof(v128_t) / sizeof(Bits)>;
    const auto input = std::bit_cast<Lanes>(value);
    Lanes result;
    Dynarmic::FP::FPSR fpsr{};
    const auto fpcr = VectorFPControl(state, fpcr_controlled);
    for (size_t lane = 0; lane < result.size(); ++lane) {
        result[lane] = ConvertFixed<Bits>(static_cast<Integer>(input[lane]),
            fractional_bits, rounding, fpcr, fpsr);
    }
    SetFPStatus(state, fpsr);
    return std::bit_cast<v128_t>(result);
}
} // namespace

// Generated code imports these raw Wasm functions, avoiding JavaScript on memory access.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t WasmCheckHalt(ArmState* state) {
    return state->halt->load();
}
extern "C" {
#define READ_MEMORY(bits, type) \
    EMSCRIPTEN_KEEPALIVE type A32ReadMemory##bits(ArmState* state, uint64_t, uint32_t address, uint32_t) { \
        return state->config->callbacks->MemoryRead##bits(address); \
    }
READ_MEMORY(8, uint32_t)
READ_MEMORY(16, uint32_t)
READ_MEMORY(32, uint32_t)
READ_MEMORY(64, uint64_t)
#undef READ_MEMORY
#define WRITE_MEMORY(bits, type) \
    EMSCRIPTEN_KEEPALIVE void A32WriteMemory##bits(ArmState* state, uint64_t, uint32_t address, type value, uint32_t) { \
        state->config->callbacks->MemoryWrite##bits(address, value); \
    }
WRITE_MEMORY(8, uint32_t)
WRITE_MEMORY(16, uint32_t)
WRITE_MEMORY(32, uint32_t)
WRITE_MEMORY(64, uint64_t)
#undef WRITE_MEMORY
#define EXCLUSIVE_MEMORY(bits, type, result_type) \
    EMSCRIPTEN_KEEPALIVE result_type A32ExclusiveReadMemory##bits(ArmState* state, uint64_t, uint32_t address, uint32_t) { \
        auto& config = *state->config; \
        const auto read = [&]() { return config.callbacks->MemoryRead##bits(address); }; \
        const type value = config.global_monitor \
            ? config.global_monitor->ReadAndMark<type>(config.processor_id, address, read) : read(); \
        state->exclusive = true; \
        state->exclusive_address = address; \
        state->exclusive_value = value; \
        return value; \
    } \
    EMSCRIPTEN_KEEPALIVE uint32_t A32ExclusiveWriteMemory##bits(ArmState* state, uint64_t, uint32_t address, result_type value, uint32_t) { \
        if (!std::exchange(state->exclusive, false)) return 1; \
        auto& config = *state->config; \
        const auto write = [&](type expected) { return config.callbacks->MemoryWriteExclusive##bits(address, value, expected); }; \
        const bool success = config.global_monitor \
            ? config.global_monitor->DoExclusiveOperation<type>(config.processor_id, address, write) \
            : address == state->exclusive_address && write(static_cast<type>(state->exclusive_value)); \
        return success ? 0 : 1; \
    }
EXCLUSIVE_MEMORY(8, uint8_t, uint32_t)
EXCLUSIVE_MEMORY(16, uint16_t, uint32_t)
EXCLUSIVE_MEMORY(32, uint32_t, uint32_t)
EXCLUSIVE_MEMORY(64, uint64_t, uint64_t)
#undef EXCLUSIVE_MEMORY
EMSCRIPTEN_KEEPALIVE void A32CallSupervisor(ArmState* state, uint32_t immediate) {
    state->config->callbacks->CallSVC(immediate);
}
EMSCRIPTEN_KEEPALIVE void A32ExceptionRaised(ArmState* state, uint32_t pc, uint64_t exception) {
    state->config->callbacks->ExceptionRaised(pc, static_cast<Dynarmic::A32::Exception>(exception));
}
EMSCRIPTEN_KEEPALIVE void A32InstructionSynchronizationBarrier(ArmState* state) {
    if (state->config->hook_isb) state->config->callbacks->InstructionSynchronizationBarrierRaised();
}
EMSCRIPTEN_KEEPALIVE void A32DataMemoryBarrier(ArmState*) {
    std::atomic_thread_fence(std::memory_order_seq_cst);
}
EMSCRIPTEN_KEEPALIVE void A32DataSynchronizationBarrier(ArmState*) {
    std::atomic_thread_fence(std::memory_order_seq_cst);
}
EMSCRIPTEN_KEEPALIVE void A32ClearExclusive(ArmState* state) {
    state->exclusive = false;
    if (state->config->global_monitor) state->config->global_monitor->ClearProcessor(state->config->processor_id);
}
EMSCRIPTEN_KEEPALIVE uint64_t WasmCallCoprocessor(ArmState*, uint32_t function, uintptr_t user_argument,
                                               uint32_t argument0, uint32_t argument1) {
    const auto callback = reinterpret_cast<decltype(Dynarmic::A32::Coprocessor::Callback::function)>(function);
    return callback(reinterpret_cast<void*>(user_argument), argument0, argument1);
}
EMSCRIPTEN_KEEPALIVE uint32_t FPCompare32(ArmState* state, uint32_t lhs, uint32_t rhs, uint32_t signal_quiet_nan) {
    Dynarmic::FP::FPSR fpsr{state->fpscr};
    const auto flags = CompareFP(lhs, rhs, signal_quiet_nan, Dynarmic::FP::FPCR{state->fpscr}, fpsr);
    SetFPStatus(state, fpsr);
    return flags;
}
EMSCRIPTEN_KEEPALIVE uint32_t FPCompare64(ArmState* state, uint64_t lhs, uint64_t rhs, uint32_t signal_quiet_nan) {
    Dynarmic::FP::FPSR fpsr{state->fpscr};
    const auto flags = CompareFP(lhs, rhs, signal_quiet_nan, Dynarmic::FP::FPCR{state->fpscr}, fpsr);
    SetFPStatus(state, fpsr);
    return flags;
}
#define VECTOR_EQUAL(name, type) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return static_cast<type>(0 - Dynarmic::FP::FPCompareEQ(left, right, fpcr, fpsr)); \
        }, lhs, rhs); \
    }
VECTOR_EQUAL(FPVectorEqual16, uint16_t)
VECTOR_EQUAL(FPVectorEqual32, uint32_t)
VECTOR_EQUAL(FPVectorEqual64, uint64_t)
#undef VECTOR_EQUAL
#define VECTOR_ORDERED(name, type, equal) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            const auto flags = CompareFP(left, right, true, fpcr, fpsr); \
            return static_cast<type>(0 - (flags == 0x20000000 || (equal && flags == 0x60000000))); \
        }, lhs, rhs); \
    }
VECTOR_ORDERED(FPVectorGreater32, uint32_t, false)
VECTOR_ORDERED(FPVectorGreater64, uint64_t, false)
VECTOR_ORDERED(FPVectorGreaterEqual32, uint32_t, true)
VECTOR_ORDERED(FPVectorGreaterEqual64, uint64_t, true)
#undef VECTOR_ORDERED
EMSCRIPTEN_KEEPALIVE v128_t FPVectorFromHalf32(ArmState* state, v128_t value, uint32_t rounding, uint32_t controlled) {
    return VectorConvert<uint32_t, uint16_t>(state, value, rounding, controlled);
}
EMSCRIPTEN_KEEPALIVE v128_t FPVectorToHalf32(ArmState* state, v128_t value, uint32_t rounding, uint32_t controlled) {
    return VectorConvert<uint16_t, uint32_t>(state, value, rounding, controlled);
}
#define VECTOR_SELECT(name, type, maximum, numeric) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return SelectFP<type, maximum, numeric>(left, right, fpcr, fpsr); \
        }, lhs, rhs); \
    }
VECTOR_SELECT(FPVectorMax32, uint32_t, true, false)
VECTOR_SELECT(FPVectorMax64, uint64_t, true, false)
VECTOR_SELECT(FPVectorMaxNumeric32, uint32_t, true, true)
VECTOR_SELECT(FPVectorMaxNumeric64, uint64_t, true, true)
VECTOR_SELECT(FPVectorMin32, uint32_t, false, false)
VECTOR_SELECT(FPVectorMin64, uint64_t, false, false)
VECTOR_SELECT(FPVectorMinNumeric32, uint32_t, false, true)
VECTOR_SELECT(FPVectorMinNumeric64, uint64_t, false, true)
#undef VECTOR_SELECT
#define VECTOR_ARITHMETIC(bits, type) \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorAdd##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPMulAdd(left, right, Dynarmic::FP::FPValue<type, false, 0, 1>(), fpcr, fpsr); \
        }, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorSub##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPMulAdd(left, right, Dynarmic::FP::FPValue<type, true, 0, 1>(), fpcr, fpsr); \
        }, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorMul##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            const auto zero = Dynarmic::FP::FPInfo<type>::Zero(((left ^ right) & Dynarmic::FP::FPInfo<type>::sign_mask) != 0); \
            return Dynarmic::FP::FPMulAdd(zero, left, right, fpcr, fpsr); \
        }, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorDiv##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return DivideFP(left, right, fpcr, fpsr); \
        }, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorSqrt##bits(ArmState* state, v128_t value, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto operand, auto fpcr, auto& fpsr) { \
            return SquareRootFP(operand, fpcr, fpsr); \
        }, value); \
    }
VECTOR_ARITHMETIC(32, uint32_t)
VECTOR_ARITHMETIC(64, uint64_t)
#undef VECTOR_ARITHMETIC
#define VECTOR_FUSED(bits, type) \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorMulAdd##bits(ArmState* state, v128_t addend, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto add, auto left, auto right, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPMulAdd(add, left, right, fpcr, fpsr); \
        }, addend, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorRoundInt##bits(ArmState* state, v128_t value, uint32_t rounding, uint32_t exact, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [&](auto operand, auto fpcr, auto& fpsr) { \
            return static_cast<type>(Dynarmic::FP::FPRoundInt(operand, fpcr, static_cast<Dynarmic::FP::RoundingMode>(rounding), exact, fpsr)); \
        }, value); \
    }
VECTOR_FUSED(16, uint16_t)
VECTOR_FUSED(32, uint32_t)
VECTOR_FUSED(64, uint64_t)
#undef VECTOR_FUSED
#define VECTOR_TO_FIXED(name, bits_type, unsigned_value) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState* state, v128_t value, uint32_t fractional_bits, uint32_t rounding, uint32_t controlled) { \
        return VectorToFixed<bits_type, unsigned_value>(state, value, fractional_bits, rounding, controlled); \
    }
VECTOR_TO_FIXED(FPVectorToSignedFixed16, uint16_t, false)
VECTOR_TO_FIXED(FPVectorToSignedFixed32, uint32_t, false)
VECTOR_TO_FIXED(FPVectorToSignedFixed64, uint64_t, false)
VECTOR_TO_FIXED(FPVectorToUnsignedFixed16, uint16_t, true)
VECTOR_TO_FIXED(FPVectorToUnsignedFixed32, uint32_t, true)
VECTOR_TO_FIXED(FPVectorToUnsignedFixed64, uint64_t, true)
#undef VECTOR_TO_FIXED
#define VECTOR_FROM_FIXED(name, bits_type, integer_type) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState* state, v128_t value, uint32_t fractional_bits, uint32_t rounding, uint32_t controlled) { \
        return VectorFromFixed<bits_type, integer_type>(state, value, fractional_bits, rounding, controlled); \
    }
VECTOR_FROM_FIXED(FPVectorFromSignedFixed32, uint32_t, int32_t)
VECTOR_FROM_FIXED(FPVectorFromSignedFixed64, uint64_t, int64_t)
VECTOR_FROM_FIXED(FPVectorFromUnsignedFixed32, uint32_t, uint32_t)
VECTOR_FROM_FIXED(FPVectorFromUnsignedFixed64, uint64_t, uint64_t)
#undef VECTOR_FROM_FIXED
#define FIXED_CONVERSION(name, input_type, result_type, bits, unsigned_value) \
    EMSCRIPTEN_KEEPALIVE result_type name(ArmState* state, input_type value, uint32_t fractional_bits, uint32_t rounding) { \
        return static_cast<result_type>(ToFixed(state, value, bits, fractional_bits, rounding, unsigned_value)); \
    }
FIXED_CONVERSION(FPSingleToFixedS16, uint32_t, uint32_t, 16, false)
FIXED_CONVERSION(FPSingleToFixedU16, uint32_t, uint32_t, 16, true)
FIXED_CONVERSION(FPSingleToFixedS32, uint32_t, uint32_t, 32, false)
FIXED_CONVERSION(FPSingleToFixedU32, uint32_t, uint32_t, 32, true)
FIXED_CONVERSION(FPSingleToFixedS64, uint32_t, uint64_t, 64, false)
FIXED_CONVERSION(FPSingleToFixedU64, uint32_t, uint64_t, 64, true)
FIXED_CONVERSION(FPDoubleToFixedS16, uint64_t, uint32_t, 16, false)
FIXED_CONVERSION(FPDoubleToFixedU16, uint64_t, uint32_t, 16, true)
FIXED_CONVERSION(FPDoubleToFixedS32, uint64_t, uint32_t, 32, false)
FIXED_CONVERSION(FPDoubleToFixedU32, uint64_t, uint32_t, 32, true)
FIXED_CONVERSION(FPDoubleToFixedS64, uint64_t, uint64_t, 64, false)
FIXED_CONVERSION(FPDoubleToFixedU64, uint64_t, uint64_t, 64, true)
#undef FIXED_CONVERSION
#define FP_ARITHMETIC(bits, type) \
    EMSCRIPTEN_KEEPALIVE type FPDiv##bits(ArmState* state, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return DivideFP(VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); \
        }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPSqrt##bits(ArmState* state, type value) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return SquareRootFP(VfpInput(state, value, fpcr, fpsr), fpcr, fpsr); \
        }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPAdd##bits(ArmState* state, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            return Dynarmic::FP::FPMulAdd(lhs, rhs, Dynarmic::FP::FPValue<type, false, 0, 1>(), fpcr, fpsr); \
        }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPSub##bits(ArmState* state, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            return Dynarmic::FP::FPMulAdd(lhs, rhs, Dynarmic::FP::FPValue<type, true, 0, 1>(), fpcr, fpsr); \
        }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPMul##bits(ArmState* state, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            const auto zero = Dynarmic::FP::FPInfo<type>::Zero(((lhs ^ rhs) & Dynarmic::FP::FPInfo<type>::sign_mask) != 0); \
            return Dynarmic::FP::FPMulAdd(zero, lhs, rhs, fpcr, fpsr); \
        }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPMulAdd##bits(ArmState* state, type addend, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { return Dynarmic::FP::FPMulAdd(VfpInput(state, addend, fpcr, fpsr), VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPMulSub##bits(ArmState* state, type minuend, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { return Dynarmic::FP::FPMulSub(VfpInput(state, minuend, fpcr, fpsr), VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); }); \
    } \
    EMSCRIPTEN_KEEPALIVE type FPRoundInt##bits(ArmState* state, type value, uint32_t rounding, uint32_t exact) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return static_cast<type>(Dynarmic::FP::FPRoundInt(VfpInput(state, value, fpcr, fpsr), fpcr, static_cast<Dynarmic::FP::RoundingMode>(rounding), exact, fpsr)); \
        }); \
    }
FP_ARITHMETIC(32, uint32_t)
FP_ARITHMETIC(64, uint64_t)
#undef FP_ARITHMETIC
#define FP_SELECT(name, type, maximum, numeric) \
    EMSCRIPTEN_KEEPALIVE type name(ArmState* state, type lhs, type rhs) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return SelectFP<type, maximum, numeric>(VfpInput(state, lhs, fpcr, fpsr), \
                VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); \
        }); \
    }
FP_SELECT(FPMax32, uint32_t, true, false)
FP_SELECT(FPMax64, uint64_t, true, false)
FP_SELECT(FPMaxNumeric32, uint32_t, true, true)
FP_SELECT(FPMaxNumeric64, uint64_t, true, true)
FP_SELECT(FPMin32, uint32_t, false, false)
FP_SELECT(FPMin64, uint64_t, false, false)
FP_SELECT(FPMinNumeric32, uint32_t, false, true)
FP_SELECT(FPMinNumeric64, uint64_t, false, true)
#undef FP_SELECT
#define FP_CONVERT(name, result_type, input_type) \
    EMSCRIPTEN_KEEPALIVE result_type name(ArmState* state, input_type value, uint32_t rounding) { \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPConvert<result_type>(VfpInput(state, value, fpcr, fpsr), fpcr, static_cast<Dynarmic::FP::RoundingMode>(rounding), fpsr); \
        }); \
    }
FP_CONVERT(FPSingleToDouble, uint64_t, uint32_t)
FP_CONVERT(FPDoubleToSingle, uint32_t, uint64_t)
FP_CONVERT(FPHalfToSingle, uint32_t, uint16_t)
FP_CONVERT(FPHalfToDouble, uint64_t, uint16_t)
FP_CONVERT(FPSingleToHalf, uint16_t, uint32_t)
FP_CONVERT(FPDoubleToHalf, uint16_t, uint64_t)
#undef FP_CONVERT
#define FP_FROM_FIXED(name, result_type, input_type, integer_type) \
    EMSCRIPTEN_KEEPALIVE result_type name(ArmState* state, input_type value, uint32_t fractional_bits, uint32_t rounding) { \
        return FromFixed<result_type>(state, static_cast<integer_type>(value), fractional_bits, rounding); \
    }
FP_FROM_FIXED(FPFixedS16ToSingle, uint32_t, uint32_t, int16_t)
FP_FROM_FIXED(FPFixedU16ToSingle, uint32_t, uint32_t, uint16_t)
FP_FROM_FIXED(FPFixedS32ToSingle, uint32_t, uint32_t, int32_t)
FP_FROM_FIXED(FPFixedU32ToSingle, uint32_t, uint32_t, uint32_t)
FP_FROM_FIXED(FPFixedS64ToSingle, uint32_t, uint64_t, int64_t)
FP_FROM_FIXED(FPFixedU64ToSingle, uint32_t, uint64_t, uint64_t)
FP_FROM_FIXED(FPFixedS16ToDouble, uint64_t, uint32_t, int16_t)
FP_FROM_FIXED(FPFixedU16ToDouble, uint64_t, uint32_t, uint16_t)
FP_FROM_FIXED(FPFixedS32ToDouble, uint64_t, uint32_t, int32_t)
FP_FROM_FIXED(FPFixedU32ToDouble, uint64_t, uint32_t, uint32_t)
FP_FROM_FIXED(FPFixedS64ToDouble, uint64_t, uint64_t, int64_t)
FP_FROM_FIXED(FPFixedU64ToDouble, uint64_t, uint64_t, uint64_t)
#undef FP_FROM_FIXED
}

namespace Dynarmic::A32 {
struct Jit::Impl {
    using Entry = int64_t (*)(ArmState*, int64_t);
    struct Region {
        Entry entry;
        uint32_t bytes;
        uint32_t first;
        uint64_t length;
        uint64_t used;
    };
    UserConfig config;
    ArmState state;
    std::atomic<uint32_t> halt{0};
    std::map<std::pair<uint64_t, uint32_t>, Region> regions;
    std::vector<Entry> retired;
    uint64_t generated_bytes = 0;
    uint64_t clock = 0;
    bool executing = false;

    explicit Impl(UserConfig config_) : config(std::move(config_)) {
        if (!config.callbacks || !config.enable_cycle_counting) {
            throw std::invalid_argument("ARM Wasm JIT requires callbacks and cycle counting");
        }
        if (config.global_monitor && config.processor_id >= config.global_monitor->GetProcessorCount()) {
            throw std::invalid_argument("ARM processor is outside the exclusive monitor");
        }
        if (config.page_table_pointer_mask_bits < 0 || config.page_table_pointer_mask_bits > 31) {
            throw std::invalid_argument("Invalid ARM page table pointer mask");
        }
        state.config = &config;
        state.halt = &halt;
    }
    ~Impl() { Clear(); ReleaseRetired(); }
    void ReleaseRetired() {
        for (auto entry : retired) ReleaseArmRegion(reinterpret_cast<uintptr_t>(entry));
        retired.clear();
    }
    auto Retire(decltype(regions)::iterator item) {
        generated_bytes -= item->second.bytes;
        retired.push_back(item->second.entry);
        return regions.erase(item);
    }
    void Clear() {
        while (!regions.empty()) Retire(regions.begin());
        if (!executing) ReleaseRetired();
    }
    Entry GetEntry(uint32_t limit, bool step) {
        const LocationDescriptor location(state.registers[15], PSR{state.cpsr}, FPSCR{state.fpscr}, step);
        const auto key = std::pair{location.UniqueHash(), limit};
        if (auto found = regions.find(key); found != regions.end()) {
            found->second.used = ++clock;
            return found->second.entry;
        }
        CodeReader reader{*config.callbacks, limit};
        const TranslationOptions options{config.arch_version, config.define_unpredictable_behaviour,
                                         config.hook_hint_instructions};
        auto block = Translate(location, &reader, options);
        if (block.CycleCount() == 0) throw std::runtime_error("ARM JIT produced a zero-cycle block");
        Azahar::Wasm::OptimizeArmBlock(block,
            config.HasOptimization(OptimizationFlag::GetSetElimination) && !config.check_halt_on_memory_access,
            config.HasOptimization(OptimizationFlag::ConstProp), config.callbacks);
        const auto json = Azahar::Wasm::SerializeArmBlock(block, [this](const auto& instruction) {
            return CoprocessorBinding(instruction, config);
        });
        const uint32_t layout[] = {offsetof(ArmState, registers), offsetof(ArmState, cpsr),
            offsetof(ArmState, extended_registers), offsetof(ArmState, fpscr), offsetof(ArmState, check_bit)};
        const uint32_t memory_config[] = {static_cast<uint32_t>(reinterpret_cast<uintptr_t>(config.page_table)),
            static_cast<uint32_t>(config.fastmem_pointer.value_or(0)), config.fastmem_pointer.has_value(),
            static_cast<uint32_t>(config.page_table_pointer_mask_bits), config.absolute_offset_page_table,
            config.detect_misaligned_access_via_page_table, config.only_detect_misalignment_via_page_table_on_page_boundary};
        uint32_t bytes = 0;
        const auto slot = CompileArmRegion(json.c_str(), layout, memory_config, &bytes);
        if (!slot) {
            char* error = ArmCompileError();
            std::string message(error);
            std::free(error);
            throw std::runtime_error(message);
        }
        const auto entry = reinterpret_cast<Entry>(slot);
        if (bytes > config.code_cache_size) {
            ReleaseArmRegion(slot);
            throw std::runtime_error("ARM region exceeds the code cache budget");
        }
        while (generated_bytes + bytes > config.code_cache_size || regions.size() >= 65536) {
            auto oldest = std::min_element(regions.begin(), regions.end(), [](auto& a, auto& b) {
                return a.second.used < b.second.used;
            });
            Retire(oldest);
        }
        ReleaseRetired();
        generated_bytes += bytes;
        regions.emplace(key, Region{entry, bytes, reader.first, uint64_t(uint32_t(reader.last - reader.first)) + 4, ++clock});
        return entry;
    }
    HaltReason Execute(bool step) {
        if (executing) throw std::logic_error("Recursive ARM JIT execution");
        halt.fetch_and(~static_cast<uint32_t>(HaltReason::CacheInvalidation));
        executing = true;
        try {
            do {
                if (halt.load()) break;
                const uint64_t budget = config.callbacks->GetTicksRemaining();
                if (!budget) break;
                const auto limit = step ? 1u : uint32_t(std::min<uint64_t>(budget, 32));
                const auto entry = GetEntry(limit, step);
                const auto bounded_budget = std::min<uint64_t>(budget, std::numeric_limits<int64_t>::max());
                const auto remaining = entry(&state, bounded_budget);
                config.callbacks->AddTicks(bounded_budget - remaining);
                ReleaseRetired();
            } while (!step);
        } catch (...) {
            executing = false;
            ReleaseRetired();
            throw;
        }
        executing = false;
        ReleaseRetired();
        const auto reason = static_cast<HaltReason>(halt.exchange(0));
        return step ? reason | HaltReason::Step : reason;
    }
};

Jit::Jit(UserConfig config) : impl(std::make_unique<Impl>(std::move(config))) {}
Jit::~Jit() = default;
HaltReason Jit::Run() {
    if (is_executing) throw std::logic_error("Recursive ARM JIT execution");
    is_executing = true;
    try { const auto reason = impl->Execute(false); is_executing = false; return reason; }
    catch (...) { is_executing = false; throw; }
}
HaltReason Jit::Step() {
    if (is_executing) throw std::logic_error("Recursive ARM JIT execution");
    is_executing = true;
    try { const auto reason = impl->Execute(true); is_executing = false; return reason; }
    catch (...) { is_executing = false; throw; }
}
void Jit::ClearCache() { impl->Clear(); if (impl->executing) HaltExecution(HaltReason::CacheInvalidation); }
void Jit::InvalidateCacheRange(uint32_t address, size_t length) {
    if (!length) return;
    for (auto item = impl->regions.begin(); item != impl->regions.end();) {
        if (Overlaps(item->second.first, item->second.length, address, length)) item = impl->Retire(item);
        else ++item;
    }
    if (impl->executing) HaltExecution(HaltReason::CacheInvalidation);
    else impl->ReleaseRetired();
}
void Jit::Reset() {
    if (is_executing) throw std::logic_error("Cannot reset an executing ARM JIT");
    impl->state = {};
    impl->state.config = &impl->config;
    impl->state.halt = &impl->halt;
}
void Jit::HaltExecution(HaltReason reason) { impl->halt.fetch_or(static_cast<uint32_t>(reason)); }
void Jit::ClearHalt(HaltReason reason) { impl->halt.fetch_and(~static_cast<uint32_t>(reason)); }
std::array<uint32_t, 16>& Jit::Regs() { return impl->state.registers; }
const std::array<uint32_t, 16>& Jit::Regs() const { return impl->state.registers; }
std::array<uint32_t, 64>& Jit::ExtRegs() { return impl->state.extended_registers; }
const std::array<uint32_t, 64>& Jit::ExtRegs() const { return impl->state.extended_registers; }
uint32_t Jit::Cpsr() const { return impl->state.cpsr; }
void Jit::SetCpsr(uint32_t value) { impl->state.cpsr = value; }
uint32_t Jit::Fpscr() const { return impl->state.fpscr; }
void Jit::SetFpscr(uint32_t value) { impl->state.fpscr = value; }
void Jit::ClearExclusiveState() { A32ClearExclusive(&impl->state); }
void Jit::DumpDisassembly() const { throw std::runtime_error("Wasm disassembly is unavailable"); }
std::vector<std::string> Jit::Disassemble() const { throw std::runtime_error("Wasm disassembly is unavailable"); }
} // namespace Dynarmic::A32
