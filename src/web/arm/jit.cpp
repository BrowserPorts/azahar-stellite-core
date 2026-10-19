// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
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
#include "dynarmic/common/crypto/aes.h"
#include "dynarmic/common/crypto/crc32.h"
#include "dynarmic/common/fp/fpcr.h"
#include "dynarmic/common/fp/fpsr.h"
#include "dynarmic/common/fp/info.h"
#include "dynarmic/common/fp/op/FPCompare.h"
#include "dynarmic/common/fp/op/FPConvert.h"
#include "dynarmic/common/fp/op/FPMulAdd.h"
#include "dynarmic/common/fp/op/FPRoundInt.h"
#include "dynarmic/common/fp/op/FPRecipEstimate.h"
#include "dynarmic/common/fp/op/FPRecipStepFused.h"
#include "dynarmic/common/fp/op/FPRSqrtEstimate.h"
#include "dynarmic/common/fp/op/FPRSqrtStepFused.h"
#include "dynarmic/common/fp/op/FPToFixed.h"
#include "dynarmic/common/fp/process_exception.h"
#include "dynarmic/common/fp/process_nan.h"
#include "dynarmic/common/fp/unpacked.h"
#include "dynarmic/common/math_util.h"
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
using RegionKey = std::pair<uint64_t, uint32_t>;
struct LinkCell {
    uint32_t slot = 0;
    uint32_t references = 0;
    uint64_t used = 0;
    uint32_t minimum_budget = 0;
    uint32_t maximum_instructions = 0;
    uint32_t promotion_remaining = 0;
    const RegionKey* key = nullptr;
#ifdef AZAHAR_ARM_JIT_BLOCK_PROFILING
    // Emitted entries and profile snapshots access this cell on its owning Wasm thread.
    uint64_t executions = 0;
#endif
};
static_assert(offsetof(LinkCell, slot) == 0);
static_assert(offsetof(LinkCell, minimum_budget) == 16);
// Match the native Dynarmic dispatch cache capacity.
constexpr size_t fast_dispatch_size = 0x10000;
struct FastDispatchEntry {
    uint64_t location = 0;
    uint32_t slot = 0;
    uint32_t minimum_budget = 0;
};
static_assert(std::has_single_bit(sizeof(FastDispatchEntry)) && std::has_single_bit(fast_dispatch_size));
size_t FastDispatchIndex(uint64_t location) {
    return ((location >> 1) ^ (location >> 32)) & (fast_dispatch_size - 1);
}
#ifdef AZAHAR_ARM_JIT_STATISTICS
std::atomic<uint64_t> native_dispatches{0}, completed_blocks{0};
static_assert(sizeof(completed_blocks) == sizeof(uint64_t) && alignof(decltype(completed_blocks)) >= 8);
std::atomic<uint64_t> budget_reuses{0};
std::atomic<uint64_t> fast_dispatch_hits{0};
#endif
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
    uint64_t next_budget{};
    uint64_t pending_ticks{};
    FastDispatchEntry* fast_dispatch{};
    LinkCell* promotion_source{};
};

void FlushTicks(ArmState* state) {
    const auto ticks = std::exchange(state->pending_ticks, 0);
    state->config->callbacks->AddTicks(ticks);
}

void RefreshBudget(ArmState* state) {
    state->next_budget = std::min<uint64_t>(state->config->callbacks->GetTicksRemaining(),
                                          std::numeric_limits<int64_t>::max());
}

EM_JS(uint32_t, CompileArmRegion, (const char* json, const uint32_t* layout, uint32_t layout_count, const uint32_t* memory_config, const char* fp_status_helpers, uint32_t* bytes), {
    try {
        if (!Module["azaharJitHelpers"]) {
            const rawExports = new Set(Object.values(wasmExports));
            Module["azaharJitHelpers"] = Object.fromEntries(Object.entries(Module)
                .filter(([name, value]) => name.startsWith("_") && typeof value === "function" && rawExports.has(value))
                .map(([name, value]) => [name.slice(1), value]));
            Module["azaharFpStatusHelpers"] = new Set(UTF8ToString(fp_status_helpers).split(" ").filter(Boolean));
        }
        const memory = HEAPU32.slice(memory_config >> 2, (memory_config >> 2) + 7);
        const result = Module["azaharJitHost"].compile(UTF8ToString(json),
            HEAPU32.slice(layout >> 2, (layout >> 2) + layout_count), wasmMemory,
            wasmExports["__indirect_function_table"], Module["azaharJitHelpers"], {
                pageTable: memory[0], ...(memory[2] ? { fastmem: memory[1] } : {}),
                pointerMaskBits: memory[3], absoluteOffset: Boolean(memory[4]),
                detectMisaligned: memory[5], boundaryOnly: Boolean(memory[6])
            }, Module["azaharFpStatusHelpers"]);
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
EM_JS(uint32_t, OptimizeArmRegion, (const uint32_t* slots, const uint32_t* links, uint32_t count, uint32_t maximum_bytes), {
    try {
        return Module["azaharJitHost"].optimize(HEAPU32.slice(slots >> 2, (slots >> 2) + count),
            HEAPU32.slice(links >> 2, (links >> 2) + count * 3), maximum_bytes);
    } catch (error) {
        Module["azaharJitError"] = String(error);
        return 0xffffffff;
    }
});

struct CodeReader final : Dynarmic::A32::TranslateCallbacks {
    Dynarmic::A32::UserCallbacks& callbacks;
    uint32_t remaining;
    uint32_t instructions = 0;
    uint32_t first = 0;
    uint32_t last = 0;
    bool read = false;
    bool decoded = false;
    uint64_t instruction_location = 0;
    uint64_t instruction_ticks = 0;
    const Dynarmic::IR::Inst* instruction_tail = nullptr;

    CodeReader(Dynarmic::A32::UserCallbacks& callbacks_, uint32_t limit)
        : callbacks(callbacks_), remaining(limit) {}
    std::optional<uint32_t> MemoryReadCode(uint32_t address) override {
        if (!read) first = address;
        last = address;
        read = true;
        return callbacks.MemoryReadCode(address);
    }
    bool PreCodeReadHook(bool thumb, uint32_t pc, Dynarmic::A32::IREmitter& ir) override {
        decoded = false;
        if (remaining-- == 0) {
            ir.SetTerm(Dynarmic::IR::Term::LinkBlock{ir.current_location});
            return false;
        }
        ++instructions;
        instruction_location = ir.current_location.UniqueHash();
        instruction_ticks = ir.block.CycleCount();
        instruction_tail = ir.block.empty() ? nullptr : &ir.block.back();
        return callbacks.PreCodeReadHook(thumb, pc, ir);
    }
    void PreCodeTranslationHook(bool thumb, uint32_t pc, Dynarmic::A32::IREmitter& ir) override {
        callbacks.PreCodeTranslationHook(thumb, pc, ir);
        decoded = true;
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
template <class Bits, bool Subtract> Bits AddFP(Bits lhs, Bits rhs,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    using Info = FPInfo<Bits>;
    const Bits left_exponent = lhs & Info::exponent_mask;
    const Bits right_exponent = rhs & Info::exponent_mask;
    const bool left_normal = left_exponent && left_exponent != Info::exponent_mask;
    const bool right_normal = right_exponent && right_exponent != Info::exponent_mask;
    if (left_normal && !(rhs & ~Info::sign_mask)) return lhs;
    const Bits right_operand = Subtract ? rhs ^ Info::sign_mask : rhs;
    if (right_normal && !(lhs & ~Info::sign_mask)) return right_operand;
    if constexpr (sizeof(Bits) == 4) {
        if (left_normal && right_normal) {
            Bits result;
            int comparison;
            const int difference = static_cast<int>(left_exponent >> Info::explicit_mantissa_width) -
                static_cast<int>(right_exponent >> Info::explicit_mantissa_width);
            if (std::abs(difference) <= 28) {
                // Aligned binary32 significands plus a carry fit in binary64's 53 bits.
                const double left_value = std::bit_cast<float>(lhs);
                const double right_value = std::bit_cast<float>(rhs);
                const double exact = Subtract ? left_value - right_value : left_value + right_value;
                result = std::bit_cast<Bits>(static_cast<float>(exact));
                const double rounded = std::bit_cast<float>(result);
                comparison = (rounded > exact) - (rounded < exact);
                if (result & Info::sign_mask) comparison = -comparison;
            } else {
                // The smaller operand is below half an ulp even at a binade boundary.
                result = difference > 0 ? lhs : right_operand;
                comparison = ((lhs ^ right_operand) & Info::sign_mask) ? 1 : -1;
            }
            const Bits exponent = result & Info::exponent_mask;
            const Bits binade = Bits{1} << Info::explicit_mantissa_width;
            // Boundary binades retain ARM's before-rounding underflow and overflow rules.
            if (exponent > binade && exponent < Info::exponent_mask - binade) {
                return RoundNative(result, (result & Info::sign_mask) != 0, comparison, fpcr, fpsr);
            }
        }
    } else if constexpr (sizeof(Bits) == 8) {
        const Bits binade = Bits{1} << Info::explicit_mantissa_width;
        // Keep all TwoSum intermediates below the overflow binade.
        if (left_normal && right_normal && left_exponent < Info::exponent_mask - binade &&
            right_exponent < Info::exponent_mask - binade) {
            const double left_value = std::bit_cast<double>(lhs);
            const double right_value = std::bit_cast<double>(right_operand);
            const double rounded = left_value + right_value;
            const Bits result = std::bit_cast<Bits>(rounded);
            const Bits exponent = result & Info::exponent_mask;
            if (exponent > binade && exponent < Info::exponent_mask - binade) {
                // Knuth TwoSum recovers the exact addition/subtraction residual in binary64.
                const double right_part = rounded - left_value;
                const double residual = (left_value - (rounded - right_part)) +
                                        (right_value - right_part);
                int comparison = (residual < 0) - (residual > 0);
                if (result & Info::sign_mask) comparison = -comparison;
                return RoundNative(result, (result & Info::sign_mask) != 0, comparison, fpcr, fpsr);
            }
        }
    }
    return FPMulAdd(lhs, rhs, FPValue<Bits, Subtract, 0, 1>(), fpcr, fpsr);
}
template <class Bits> Bits MultiplyFP(Bits lhs, Bits rhs,
    Dynarmic::FP::FPCR fpcr, Dynarmic::FP::FPSR& fpsr) {
    using namespace Dynarmic::FP;
    using Info = FPInfo<Bits>;
    const Bits left_exponent = lhs & Info::exponent_mask;
    const Bits right_exponent = rhs & Info::exponent_mask;
    const bool sign = ((lhs ^ rhs) & Info::sign_mask) != 0;
    const bool left_normal = left_exponent && left_exponent != Info::exponent_mask;
    const bool right_normal = right_exponent && right_exponent != Info::exponent_mask;
    // Finite normal values and signed zeros produce an exact signed-zero product.
    if ((left_normal && !(rhs & ~Info::sign_mask)) ||
        (right_normal && !(lhs & ~Info::sign_mask)) ||
        !((lhs | rhs) & ~Info::sign_mask)) return Info::Zero(sign);
    if (left_normal && right_normal) {
        using Float = std::conditional_t<sizeof(Bits) == 4, float, double>;
        const Float left_value = std::bit_cast<Float>(lhs);
        const Float right_value = std::bit_cast<Float>(rhs);
        const Bits result = std::bit_cast<Bits>(left_value * right_value);
        const Bits exponent = result & Info::exponent_mask;
        const Bits binade = Bits{1} << Info::explicit_mantissa_width;
        // Boundary binades retain ARM's before-rounding underflow and overflow rules.
        if (exponent > binade && exponent < Info::exponent_mask - binade) {
            if constexpr (sizeof(Bits) == 4) {
                // A binary32 product has at most 48 significant bits and is exact in binary64.
                const double exact = static_cast<double>(left_value) * static_cast<double>(right_value);
                const double rounded = static_cast<double>(std::bit_cast<Float>(result));
                const int comparison = (rounded > exact) - (rounded < exact);
                return RoundNative(result, sign, sign ? -comparison : comparison, fpcr, fpsr);
            } else {
                const uint64_t left = (lhs & Info::mantissa_mask) | Info::implicit_leading_bit;
                const uint64_t right = (rhs & Info::mantissa_mask) | Info::implicit_leading_bit;
                const uint64_t output = (result & Info::mantissa_mask) | Info::implicit_leading_bit;
                const int shift = static_cast<int>(exponent >> Info::explicit_mantissa_width) -
                    static_cast<int>(left_exponent >> Info::explicit_mantissa_width) -
                    static_cast<int>(right_exponent >> Info::explicit_mantissa_width) +
                    Info::exponent_bias + Info::explicit_mantissa_width;
                // The nearest product's error is at most 2^52 in significand-product units.
                // Its signed value survives subtraction using only the low 64 product bits.
                const int64_t error = std::bit_cast<int64_t>((output << shift) - left * right);
                return RoundNative(result, sign, (error > 0) - (error < 0), fpcr, fpsr);
            }
        }
    }
    return FPMulAdd(Info::Zero(sign), lhs, rhs, fpcr, fpsr);
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
template <class Type> v128_t SaturatingVectorShift(ArmState* state, v128_t value, v128_t counts) {
    using Unsigned = std::make_unsigned_t<Type>;
    using Lanes = std::array<Type, sizeof(v128_t) / sizeof(Type)>;
    const auto input = std::bit_cast<Lanes>(value);
    const auto shifts = std::bit_cast<std::array<Unsigned, sizeof(v128_t) / sizeof(Type)>>(counts);
    constexpr int bits = sizeof(Type) * 8;
    Lanes result;
    bool saturated = false;
    for (size_t lane = 0; lane < result.size(); ++lane) {
        const auto element = input[lane];
        const int shift = std::max<int>(static_cast<int8_t>(shifts[lane] & 0xff),
            std::is_signed_v<Type> ? 1 - bits : -bits);
        const auto bound = [&] {
            if constexpr (std::is_signed_v<Type>) {
                if (element < 0) return std::numeric_limits<Type>::min();
            }
            return std::numeric_limits<Type>::max();
        };
        if (element == 0 || shift <= -bits) result[lane] = 0;
        else if (shift < 0) result[lane] = static_cast<Type>(element >> -shift);
        else if (shift >= bits) { result[lane] = bound(); saturated = true; }
        else {
            const Type shifted = static_cast<Type>(static_cast<Unsigned>(element) << shift);
            if ((shifted >> shift) != element) { result[lane] = bound(); saturated = true; }
            else result[lane] = shifted;
        }
    }
    if (saturated) state->fpscr |= 1u << 27;
    return std::bit_cast<v128_t>(result);
}
template <class Type> v128_t SaturatingUnsignedVectorShift(ArmState* state, v128_t value, uint32_t shift) {
    using Unsigned = std::make_unsigned_t<Type>;
    const auto input = std::bit_cast<std::array<Type, sizeof(v128_t) / sizeof(Type)>>(value);
    std::array<Unsigned, sizeof(v128_t) / sizeof(Type)> result;
    constexpr uint32_t bits = sizeof(Type) * 8;
    bool saturated = false;
    for (size_t lane = 0; lane < result.size(); ++lane) {
        const auto element = input[lane];
        if (element == 0) result[lane] = 0;
        else if (element < 0) { result[lane] = 0; saturated = true; }
        else if (shift >= bits) { result[lane] = std::numeric_limits<Unsigned>::max(); saturated = true; }
        else {
            const Unsigned shifted = static_cast<Unsigned>(element) << shift;
            if ((shifted >> shift) != static_cast<Unsigned>(element)) {
                result[lane] = std::numeric_limits<Unsigned>::max(); saturated = true;
            } else result[lane] = shifted;
        }
    }
    if (saturated) state->fpscr |= 1u << 27;
    return std::bit_cast<v128_t>(result);
}
} // namespace

// Generated code imports these raw Wasm functions, avoiding JavaScript on memory access.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t WasmCheckHalt(ArmState* state) {
    return state->halt->load();
}
extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_arm_jit_statistics_enabled() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    return true;
#else
    return false;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint64_t azahar_arm_jit_native_dispatches() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    return native_dispatches.load(std::memory_order_relaxed);
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint64_t azahar_arm_jit_completed_blocks() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    return completed_blocks.load(std::memory_order_relaxed);
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint64_t azahar_arm_jit_linked_blocks() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    const auto blocks = completed_blocks.load(std::memory_order_relaxed);
    const auto dispatches = native_dispatches.load(std::memory_order_relaxed);
    return blocks > dispatches ? blocks - dispatches : 0;
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint64_t azahar_arm_jit_budget_reuses() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    return budget_reuses.load(std::memory_order_relaxed);
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint64_t azahar_arm_jit_fast_dispatch_hits() {
#ifdef AZAHAR_ARM_JIT_STATISTICS
    return fast_dispatch_hits.load(std::memory_order_relaxed);
#else
    return 0;
#endif
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
    FlushTicks(state);
    state->config->callbacks->CallSVC(immediate);
    RefreshBudget(state);
}
EMSCRIPTEN_KEEPALIVE void A32ExceptionRaised(ArmState* state, uint32_t pc, uint64_t exception) {
    FlushTicks(state);
    state->config->callbacks->ExceptionRaised(pc, static_cast<Dynarmic::A32::Exception>(exception));
    RefreshBudget(state);
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
#define VECTOR_RECIPROCAL(bits, type) \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorRecipEstimate##bits(ArmState* state, v128_t value, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto operand, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPRecipEstimate(operand, fpcr, fpsr); \
        }, value); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorRSqrtEstimate##bits(ArmState* state, v128_t value, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto operand, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPRSqrtEstimate(operand, fpcr, fpsr); \
        }, value); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorRecipStepFused##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPRecipStepFused(left, right, fpcr, fpsr); \
        }, lhs, rhs); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t FPVectorRSqrtStepFused##bits(ArmState* state, v128_t lhs, v128_t rhs, uint32_t controlled) { \
        return VectorFP<type>(state, controlled, [](auto left, auto right, auto fpcr, auto& fpsr) { \
            return Dynarmic::FP::FPRSqrtStepFused(left, right, fpcr, fpsr); \
        }, lhs, rhs); \
    }
VECTOR_RECIPROCAL(16, uint16_t)
VECTOR_RECIPROCAL(32, uint32_t)
VECTOR_RECIPROCAL(64, uint64_t)
#undef VECTOR_RECIPROCAL
#define INTEGER_RECIPROCAL(name, operation, threshold) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState*, v128_t value) { \
        auto lanes = std::bit_cast<std::array<uint32_t, 4>>(value); \
        for (auto& lane : lanes) { \
            lane = lane < threshold ? UINT32_MAX \
                : (0x100u | Dynarmic::Common::operation(lane >> 23)) << 23; \
        } \
        return std::bit_cast<v128_t>(lanes); \
    }
INTEGER_RECIPROCAL(VectorUnsignedRecipEstimate, RecipEstimate, 0x80000000u)
INTEGER_RECIPROCAL(VectorUnsignedRecipSqrtEstimate, RecipSqrtEstimate, 0x40000000u)
#undef INTEGER_RECIPROCAL
#define VECTOR_SATURATING_SHIFT(bits, signed_type, unsigned_type) \
    EMSCRIPTEN_KEEPALIVE v128_t VectorSignedSaturatedShiftLeft##bits(ArmState* state, v128_t value, v128_t counts) { \
        return SaturatingVectorShift<signed_type>(state, value, counts); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t VectorUnsignedSaturatedShiftLeft##bits(ArmState* state, v128_t value, v128_t counts) { \
        return SaturatingVectorShift<unsigned_type>(state, value, counts); \
    } \
    EMSCRIPTEN_KEEPALIVE v128_t VectorSignedSaturatedShiftLeftUnsigned##bits(ArmState* state, v128_t value, uint32_t shift) { \
        return SaturatingUnsignedVectorShift<signed_type>(state, value, shift); \
    }
VECTOR_SATURATING_SHIFT(8, int8_t, uint8_t)
VECTOR_SATURATING_SHIFT(16, int16_t, uint16_t)
VECTOR_SATURATING_SHIFT(32, int32_t, uint32_t)
VECTOR_SATURATING_SHIFT(64, int64_t, uint64_t)
#undef VECTOR_SATURATING_SHIFT
#define AES_OPERATION(name, operation) \
    EMSCRIPTEN_KEEPALIVE v128_t name(ArmState*, v128_t value) { \
        using namespace Dynarmic::Common::Crypto; \
        AES::State result; \
        AES::operation(result, std::bit_cast<AES::State>(value)); \
        return std::bit_cast<v128_t>(result); \
    }
AES_OPERATION(AESDecryptSingleRound, DecryptSingleRound)
AES_OPERATION(AESEncryptSingleRound, EncryptSingleRound)
AES_OPERATION(AESInverseMixColumns, InverseMixColumns)
AES_OPERATION(AESMixColumns, MixColumns)
#undef AES_OPERATION
#define CRC_OPERATIONS(bits, type) \
    EMSCRIPTEN_KEEPALIVE uint32_t CRC32ISO##bits(ArmState*, uint32_t crc, type value) { \
        return Dynarmic::Common::Crypto::CRC32::ComputeCRC32ISO(crc, value, bits / 8); \
    } \
    EMSCRIPTEN_KEEPALIVE uint32_t CRC32Castagnoli##bits(ArmState*, uint32_t crc, type value) { \
        return Dynarmic::Common::Crypto::CRC32::ComputeCRC32Castagnoli(crc, value, bits / 8); \
    }
CRC_OPERATIONS(8, uint32_t)
CRC_OPERATIONS(16, uint32_t)
CRC_OPERATIONS(32, uint32_t)
CRC_OPERATIONS(64, uint64_t)
#undef CRC_OPERATIONS
EMSCRIPTEN_KEEPALIVE v128_t SHA256Hash(ArmState*, v128_t x, v128_t y, v128_t words, uint32_t part1) {
    auto left = std::bit_cast<std::array<uint32_t, 4>>(x);
    auto right = std::bit_cast<std::array<uint32_t, 4>>(y);
    const auto message = std::bit_cast<std::array<uint32_t, 4>>(words);
    for (const auto word : message) {
        const auto sigma1 = std::rotr(right[0], 6) ^ std::rotr(right[0], 11) ^ std::rotr(right[0], 25);
        const auto choice = (right[0] & right[1]) ^ (~right[0] & right[2]);
        const auto first = right[3] + sigma1 + choice + word;
        const auto sigma0 = std::rotr(left[0], 2) ^ std::rotr(left[0], 13) ^ std::rotr(left[0], 22);
        const auto majority = (left[0] & left[1]) ^ (left[0] & left[2]) ^ (left[1] & left[2]);
        right = {left[3] + first, right[0], right[1], right[2]};
        left = {first + sigma0 + majority, left[0], left[1], left[2]};
    }
    return std::bit_cast<v128_t>(part1 ? left : right);
}
EMSCRIPTEN_KEEPALIVE v128_t SHA256MessageSchedule0(ArmState*, v128_t x, v128_t y) {
    auto words = std::bit_cast<std::array<uint32_t, 4>>(x);
    const auto next = std::bit_cast<std::array<uint32_t, 4>>(y);
    for (size_t lane = 0; lane < words.size(); ++lane) {
        const auto value = lane == 3 ? next[0] : words[lane + 1];
        words[lane] += std::rotr(value, 7) ^ std::rotr(value, 18) ^ (value >> 3);
    }
    return std::bit_cast<v128_t>(words);
}
EMSCRIPTEN_KEEPALIVE v128_t SHA256MessageSchedule1(ArmState*, v128_t x, v128_t y, v128_t z) {
    auto words = std::bit_cast<std::array<uint32_t, 4>>(x);
    const auto middle = std::bit_cast<std::array<uint32_t, 4>>(y);
    const auto last = std::bit_cast<std::array<uint32_t, 4>>(z);
    const auto sigma1 = [](uint32_t value) {
        return std::rotr(value, 17) ^ std::rotr(value, 19) ^ (value >> 10);
    };
    words[0] += middle[1] + sigma1(last[2]);
    words[1] += middle[2] + sigma1(last[3]);
    words[2] += middle[3] + sigma1(words[0]);
    words[3] += last[0] + sigma1(words[1]);
    return std::bit_cast<v128_t>(words);
}
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
#define FP_ARITHMETIC(emit, bits, type) \
    emit(type, FPDiv##bits, (ArmState* state, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return DivideFP(VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); \
        }); \
    ) \
    emit(type, FPSqrt##bits, (ArmState* state, type value), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return SquareRootFP(VfpInput(state, value, fpcr, fpsr), fpcr, fpsr); \
        }); \
    ) \
    emit(type, FPAdd##bits, (ArmState* state, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            return AddFP<type, false>(lhs, rhs, fpcr, fpsr); \
        }); \
    ) \
    emit(type, FPSub##bits, (ArmState* state, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            return AddFP<type, true>(lhs, rhs, fpcr, fpsr); \
        }); \
    ) \
    emit(type, FPMul##bits, (ArmState* state, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            lhs = VfpInput(state, lhs, fpcr, fpsr); \
            rhs = VfpInput(state, rhs, fpcr, fpsr); \
            return MultiplyFP(lhs, rhs, fpcr, fpsr); \
        }); \
    ) \
    emit(type, FPMulAdd##bits, (ArmState* state, type addend, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { return Dynarmic::FP::FPMulAdd(VfpInput(state, addend, fpcr, fpsr), VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); }); \
    ) \
    emit(type, FPMulSub##bits, (ArmState* state, type minuend, type lhs, type rhs), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { return Dynarmic::FP::FPMulSub(VfpInput(state, minuend, fpcr, fpsr), VfpInput(state, lhs, fpcr, fpsr), VfpInput(state, rhs, fpcr, fpsr), fpcr, fpsr); }); \
    ) \
    emit(type, FPRoundInt##bits, (ArmState* state, type value, uint32_t rounding, uint32_t exact), \
        return FloatingPoint(state, [&](auto fpcr, auto& fpsr) { \
            return static_cast<type>(Dynarmic::FP::FPRoundInt(VfpInput(state, value, fpcr, fpsr), fpcr, static_cast<Dynarmic::FP::RoundingMode>(rounding), exact, fpsr)); \
        }); \
    )
#define FP_HELPER_DEFINITION(result_type, name, parameters, ...) \
    EMSCRIPTEN_KEEPALIVE result_type name parameters { __VA_ARGS__ }
FP_ARITHMETIC(FP_HELPER_DEFINITION, 32, uint32_t)
FP_ARITHMETIC(FP_HELPER_DEFINITION, 64, uint64_t)
#undef FP_HELPER_DEFINITION
#define FP_CONVERSIONS(emit) \
    emit(FPSingleToDouble, uint64_t, uint32_t) \
    emit(FPDoubleToSingle, uint32_t, uint64_t) \
    emit(FPHalfToSingle, uint32_t, uint16_t) \
    emit(FPHalfToDouble, uint64_t, uint16_t) \
    emit(FPSingleToHalf, uint16_t, uint32_t) \
    emit(FPDoubleToHalf, uint16_t, uint64_t)
// These helpers only add FPSCR exception flags; registers and processor modes are preserved.
// With valid IR operands, only enabled FP traps can interrupt their execution.
#define FP_HELPER_NAME(result_type, name, parameters, ...) #name " "
#define FP_CONVERSION_NAME(name, result_type, input_type) #name " "
constexpr char fp_status_helpers[] =
    FP_ARITHMETIC(FP_HELPER_NAME, 32, uint32_t)
    FP_ARITHMETIC(FP_HELPER_NAME, 64, uint64_t)
    FP_CONVERSIONS(FP_CONVERSION_NAME);
#undef FP_CONVERSION_NAME
#undef FP_HELPER_NAME
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
FP_CONVERSIONS(FP_CONVERT)
#undef FP_CONVERT
#undef FP_CONVERSIONS
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
    using Entry = int64_t (*)(ArmState*, int64_t, uint64_t, uint64_t);
    struct CodeRange {
        uint32_t first;
        uint64_t length;
    };
    struct Region {
        Entry entry;
        uint32_t bytes;
        uint32_t first;
        uint64_t length;
        LinkCell* source;
        LinkCell* destination;
        uint32_t minimum_budget;
        uint32_t maximum_instructions;
        std::vector<RegionKey> links;
        std::vector<CodeRange> ranges;
        bool optimized = false;
        uint32_t block_links = 0;
    };
    UserConfig config;
    ArmState state;
    std::atomic<uint32_t> halt{0};
    std::map<RegionKey, Region> regions;
    std::map<RegionKey, LinkCell> links;
    std::vector<Region> retired;
    std::array<FastDispatchEntry, fast_dispatch_size> fast_dispatch{};
    // Native entry selection also checks the requested translation limit.
    std::array<uint32_t, fast_dispatch_size> fast_dispatch_limits{};
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
        state.fast_dispatch = fast_dispatch.data();
    }
    ~Impl() { Clear(); ReleaseRetired(); }
    void ReleaseRetired() {
        for (auto& region : retired) {
            ReleaseArmRegion(reinterpret_cast<uintptr_t>(region.entry));
            ReleaseLinks(region.links);
        }
        retired.clear();
    }
    LinkCell& AcquireLink(RegionKey key, std::vector<RegionKey>& references) {
        const auto [item, inserted] = links.try_emplace(key);
        try { references.push_back(key); }
        catch (...) { if (inserted) links.erase(item); throw; }
        auto& cell = item->second;
        cell.key = &item->first;
        ++cell.references;
        return cell;
    }
    void ReleaseLinks(const std::vector<RegionKey>& references) {
        for (const auto& key : references) {
            const auto cell = links.find(key);
            if (--cell->second.references == 0 && cell->second.slot == 0) links.erase(cell);
        }
    }
    auto Retire(decltype(regions)::iterator item) {
        retired.push_back(std::move(item->second));
        const auto& region = retired.back();
        auto& fast = fast_dispatch[FastDispatchIndex(item->first.first)];
        if (fast.location == item->first.first && fast.slot == reinterpret_cast<uintptr_t>(region.entry)) {
            fast.slot = 0;
        }
        generated_bytes -= region.bytes;
        // Disconnect incoming branches before retiring code or recycling its table slot.
        region.source->slot = 0;
        if (region.destination->slot == reinterpret_cast<uintptr_t>(region.entry)) {
            region.destination->slot = 0;
        }
        return regions.erase(item);
    }
    void Publish(uint64_t location, const Region& region) {
        auto& destination = *region.destination;
        if (!destination.slot || region.maximum_instructions >= destination.maximum_instructions) {
            destination.minimum_budget = region.minimum_budget;
            destination.maximum_instructions = region.maximum_instructions;
            destination.slot = reinterpret_cast<uintptr_t>(region.entry);
        }
        if (config.HasOptimization(OptimizationFlag::FastDispatch)) {
            const auto index = FastDispatchIndex(location);
            fast_dispatch[index] = {
                location, destination.slot, destination.minimum_budget};
            fast_dispatch_limits[index] = destination.maximum_instructions;
        }
    }
    void Clear() {
        while (!regions.empty()) Retire(regions.begin());
        fast_dispatch.fill({});
        fast_dispatch_limits.fill(0);
        if (!executing) ReleaseRetired();
    }
    void Promote(decltype(regions)::iterator root) {
        if (root->second.optimized) return;
        std::vector<decltype(root)> selected{root};
        for (size_t index = 0; index < selected.size() && selected.size() < 8; ++index) {
            const auto& block = selected[index]->second;
            for (size_t link = 0; link < block.block_links; ++link) {
                const auto& key = block.links[link];
                if (key.second || std::any_of(selected.begin(), selected.end(), [&](const auto& item) {
                        return item->first.first == key.first;
                    })) continue;
                const auto& cell = links.at(key);
                if (!cell.slot) continue;
                for (auto peer = regions.lower_bound({key.first, 0});
                     peer != regions.end() && peer->first.first == key.first; ++peer) {
                    if (reinterpret_cast<uintptr_t>(peer->second.entry) == cell.slot) {
                        selected.push_back(peer);
                        break;
                    }
                }
                if (selected.size() == 8) break;
            }
        }
        std::vector<uint32_t> slots, internal;
        std::vector<CodeRange> ranges;
        std::vector<RegionKey> references;
        try {
            for (size_t index = 0; index < selected.size(); ++index) {
                const auto& region = selected[index]->second;
                slots.push_back(reinterpret_cast<uintptr_t>(region.entry));
                internal.insert(internal.end(), {static_cast<uint32_t>(reinterpret_cast<uintptr_t>(region.destination)),
                    static_cast<uint32_t>(index), region.minimum_budget});
                ranges.push_back({region.first, region.length});
                // Peer code is copied, and its outgoing cells remain owned after peer eviction.
                if (index) for (size_t link = 0; link < region.block_links; ++link) {
                    AcquireLink(region.links[link], references);
                }
            }
            auto& region = root->second;
            region.links.reserve(region.links.size() + references.size());
            const auto bytes = OptimizeArmRegion(slots.data(), internal.data(), slots.size(), config.code_cache_size);
            if (bytes == std::numeric_limits<uint32_t>::max()) {
                char* error = ArmCompileError();
                std::string message(error);
                std::free(error);
                throw std::runtime_error(message);
            }
            if (!bytes) { ReleaseLinks(references); return; }
            region.links.insert(region.links.end(), references.begin(), references.end());
            references.clear();
            region.ranges = std::move(ranges);
            generated_bytes -= region.bytes;
            generated_bytes += bytes;
            region.bytes = bytes;
            region.optimized = true;
            while (generated_bytes > config.code_cache_size) {
                auto oldest = regions.end();
                for (auto item = regions.begin(); item != regions.end(); ++item) {
                    if (item != root && (oldest == regions.end() || item->second.source->used < oldest->second.source->used)) {
                        oldest = item;
                    }
                }
                if (oldest == regions.end()) throw std::runtime_error("ARM hot region exceeds the code cache budget");
                Retire(oldest);
            }
        } catch (...) { ReleaseLinks(references); throw; }
    }
    void PromotePending() {
        const auto* source = std::exchange(state.promotion_source, nullptr);
        if (!source) return;
        const auto item = regions.find(*source->key);
        if (item == regions.end() || item->second.source != source || item->second.optimized) return;
        // Retry after more executions if the outgoing blocks are not cached yet.
        item->second.source->promotion_remaining = AZAHAR_ARM_JIT_REGION_AFTER;
        Promote(item);
        if (item->second.optimized) item->second.source->promotion_remaining = 0;
    }
    Entry GetEntry(uint32_t limit, bool step) {
        const LocationDescriptor location(state.registers[15], PSR{state.cpsr}, FPSCR{state.fpscr}, step);
        const auto key = std::pair{location.UniqueHash(), limit};
        if (!step && config.HasOptimization(OptimizationFlag::FastDispatch)) {
            const auto index = FastDispatchIndex(key.first);
            const auto& fast = fast_dispatch[index];
            if (fast.location == key.first && fast.slot && fast.minimum_budget <= limit &&
                fast_dispatch_limits[index] >= limit) {
#ifdef AZAHAR_ARM_JIT_STATISTICS
                fast_dispatch_hits.fetch_add(1, std::memory_order_relaxed);
#endif
                // Emitted code records use, and retirement disconnects this slot.
                const auto entry = reinterpret_cast<Entry>(fast.slot);
                return entry;
            }
        }
        auto cached = regions.end();
        const auto first = regions.lower_bound(key);
        if (first != regions.end() && first->first == key) {
            cached = first;
        } else {
            // A branch can end a block before its translation limit. Reuse that code
            // when its actual instruction bound fits the smaller remaining budget.
            for (auto candidate = first;
                 candidate != regions.end() && candidate->first.first == key.first; ++candidate) {
                if (candidate->second.minimum_budget <= limit) cached = candidate;
            }
        }
        if (cached != regions.end()) {
#ifdef AZAHAR_ARM_JIT_STATISTICS
            if (cached->first != key) budget_reuses.fetch_add(1, std::memory_order_relaxed);
#endif
            cached->second.source->used = clock;
            Publish(key.first, cached->second);
            return cached->second.entry;
        }
        CodeReader reader{*config.callbacks, limit};
        const TranslationOptions options{config.arch_version, config.define_unpredictable_behaviour,
                                         config.hook_hint_instructions};
        auto block = Translate(location, &reader, options);
        if (block.CycleCount() == 0) throw std::runtime_error("ARM JIT produced a zero-cycle block");
        // A condition-boundary lookahead changes neither the location, IR, nor ticks.
        const bool empty_lookahead = reader.decoded &&
            block.EndLocation().Value() == reader.instruction_location &&
            block.CycleCount() == reader.instruction_ticks &&
            (block.empty() ? nullptr : &block.back()) == reader.instruction_tail;
        const auto instruction_count = reader.instructions - uint32_t(empty_lookahead);
        Azahar::Wasm::OptimizeArmBlock(block,
            config.HasOptimization(OptimizationFlag::GetSetElimination) && !config.check_halt_on_memory_access,
            config.HasOptimization(OptimizationFlag::ConstProp), config.callbacks);
        std::vector<RegionKey> references;
        Entry entry = nullptr;
        bool installed = false;
        try {
            auto& source = AcquireLink(key, references);
            auto& destination = AcquireLink({location.UniqueHash(), 0}, references);
            const std::function<uint32_t(uint64_t)> link =
                config.HasOptimization(OptimizationFlag::BlockLinking) && !step ?
                    std::function<uint32_t(uint64_t)>{[&](uint64_t destination) {
                        return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(
                            &AcquireLink({destination, 0}, references)));
                    }} : std::function<uint32_t(uint64_t)>{};
            const auto json = Azahar::Wasm::SerializeArmBlock(block, [this](const auto& instruction) {
                return CoprocessorBinding(instruction, config);
            }, config.always_little_endian, reinterpret_cast<uintptr_t>(&source), link,
                config.HasOptimization(OptimizationFlag::FastDispatch) && !step);
            // Only blocks with static outgoing links can form a hot region.
            const bool can_promote = references.size() > 2;
            source.promotion_remaining = can_promote ? AZAHAR_ARM_JIT_REGION_AFTER : 0;
            const uint32_t layout[] = {offsetof(ArmState, registers), offsetof(ArmState, cpsr),
                offsetof(ArmState, extended_registers), offsetof(ArmState, fpscr), offsetof(ArmState, check_bit), 8,
                offsetof(ArmState, halt), offsetof(ArmState, next_budget),
                offsetof(ArmState, pending_ticks), offsetof(LinkCell, used), offsetof(LinkCell, minimum_budget),
#ifdef AZAHAR_ARM_JIT_STATISTICS
                reinterpret_cast<uintptr_t>(&completed_blocks),
#else
                0,
#endif
                offsetof(ArmState, fast_dispatch), fast_dispatch_size - 1,
                std::countr_zero(sizeof(FastDispatchEntry)), offsetof(FastDispatchEntry, location),
                offsetof(FastDispatchEntry, slot), offsetof(FastDispatchEntry, minimum_budget),
#ifdef AZAHAR_ARM_JIT_STATISTICS
                reinterpret_cast<uintptr_t>(&fast_dispatch_hits),
#else
                0,
#endif
                offsetof(ArmState, promotion_source),
                !step && config.HasOptimization(OptimizationFlag::BlockLinking)
                    ? offsetof(LinkCell, promotion_remaining) : 0,
#ifdef AZAHAR_ARM_JIT_BLOCK_PROFILING
                offsetof(LinkCell, executions)
#else
                0
#endif
            };
            const uint32_t memory_config[] = {static_cast<uint32_t>(reinterpret_cast<uintptr_t>(config.page_table)),
                static_cast<uint32_t>(config.fastmem_pointer.value_or(0)), config.fastmem_pointer.has_value(),
                static_cast<uint32_t>(config.page_table_pointer_mask_bits), config.absolute_offset_page_table,
                config.detect_misaligned_access_via_page_table, config.only_detect_misalignment_via_page_table_on_page_boundary};
            uint32_t bytes = 0;
            const auto slot = CompileArmRegion(json.c_str(), layout, std::size(layout), memory_config,
                                               fp_status_helpers, &bytes);
            if (!slot) {
                char* error = ArmCompileError();
                std::string message(error);
                std::free(error);
                throw std::runtime_error(message);
            }
            entry = reinterpret_cast<Entry>(slot);
            if (bytes > config.code_cache_size) {
                throw std::runtime_error("ARM region exceeds the code cache budget");
            }
            while (generated_bytes + bytes > config.code_cache_size || regions.size() >= 65536) {
                auto oldest = std::min_element(regions.begin(), regions.end(), [](auto& a, auto& b) {
                    return a.second.source->used < b.second.source->used;
                });
                Retire(oldest);
            }
            ReleaseRetired();
            auto region = regions.emplace(key, Region{entry, bytes, reader.first,
                uint64_t(uint32_t(reader.last - reader.first)) + 4, &source, &destination,
                std::max(1u, std::min(instruction_count, limit)), limit, {}}).first;
            region->second.block_links = references.size();
            region->second.links = std::move(references);
            generated_bytes += bytes;
            source.slot = slot;
            source.used = clock;
            Publish(key.first, region->second);
            installed = true;
            return entry;
        } catch (...) {
            if (!installed) {
                if (entry) ReleaseArmRegion(reinterpret_cast<uintptr_t>(entry));
                ReleaseLinks(references);
            }
            throw;
        }
    }
    HaltReason Execute(bool step) {
        if (executing) throw std::logic_error("Recursive ARM JIT execution");
        halt.fetch_and(~static_cast<uint32_t>(HaltReason::CacheInvalidation));
        executing = true;
        state.pending_ticks = 0;
        try {
            if (step) state.next_budget = 1;
            else RefreshBudget(&state);
            do {
                if (halt.load()) break;
                const uint64_t budget = state.next_budget;
                if (!budget) break;
                const auto limit = step ? 1u : uint32_t(std::min<uint64_t>(budget, 32));
                // All blocks reached by this entry share the same cache age.
                ++clock;
                const auto entry = GetEntry(limit, step);
#ifdef AZAHAR_ARM_JIT_STATISTICS
                native_dispatches.fetch_add(1, std::memory_order_relaxed);
#endif
                entry(&state, budget, state.pending_ticks, clock);
                // The completed source stays owned until retired code is released below.
                PromotePending();
                ReleaseRetired();
            } while (!step);
            FlushTicks(&state);
        } catch (...) {
            executing = false;
            ReleaseRetired();
            if (state.pending_ticks) FlushTicks(&state);
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
        if (Overlaps(item->second.first, item->second.length, address, length) ||
            std::any_of(item->second.ranges.begin(), item->second.ranges.end(), [&](const auto& range) {
                return Overlaps(range.first, range.length, address, length);
            })) item = impl->Retire(item);
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
    impl->state.fast_dispatch = impl->fast_dispatch.data();
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
