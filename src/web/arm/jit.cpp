// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <limits>
#include <map>
#include <stdexcept>
#include <utility>
#include <vector>
#include <emscripten.h>
#include "../compiler/ir_json.h"
#include "dynarmic/frontend/A32/a32_ir_emitter.h"
#include "dynarmic/frontend/A32/a32_location_descriptor.h"
#include "dynarmic/frontend/A32/translate/a32_translate.h"
#include "dynarmic/interface/A32/a32.h"
#include "dynarmic/interface/A32/coprocessor.h"
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
    Dynarmic::A32::UserConfig* config{};
};

EM_JS(uint32_t, CompileArmRegion, (const char* json, const uint32_t* layout, uint32_t* bytes), {
    try {
        if (!Module["azaharJitHelpers"]) {
            const rawExports = new Set(Object.values(wasmExports));
            Module["azaharJitHelpers"] = Object.fromEntries(Object.entries(Module)
                .filter(([name, value]) => name.startsWith("_") && typeof value === "function" && rawExports.has(value))
                .map(([name, value]) => [name.slice(1), value]));
        }
        const result = Module["azaharJitHost"].compile(UTF8ToString(json),
            HEAPU32.slice(layout >> 2, (layout >> 2) + 5), wasmMemory,
            wasmExports["__indirect_function_table"], Module["azaharJitHelpers"]);
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
} // namespace

// Generated code imports these raw Wasm functions, avoiding JavaScript on memory access.
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
EMSCRIPTEN_KEEPALIVE void A32ClearExclusive(ArmState* state) { state->exclusive = false; }
EMSCRIPTEN_KEEPALIVE uint64_t WasmCallCoprocessor(ArmState*, uint32_t function, uintptr_t user_argument,
                                               uint32_t argument0, uint32_t argument1) {
    const auto callback = reinterpret_cast<decltype(Dynarmic::A32::Coprocessor::Callback::function)>(function);
    return callback(reinterpret_cast<void*>(user_argument), argument0, argument1);
}
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
        state.config = &config;
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
        const auto block = Translate(location, &reader, options);
        if (block.CycleCount() == 0) throw std::runtime_error("ARM JIT produced a zero-cycle block");
        const auto json = Azahar::Wasm::SerializeArmBlock(block, [this](const auto& instruction) {
            return CoprocessorBinding(instruction, config);
        });
        const uint32_t layout[] = {offsetof(ArmState, registers), offsetof(ArmState, cpsr),
            offsetof(ArmState, extended_registers), offsetof(ArmState, fpscr), offsetof(ArmState, check_bit)};
        uint32_t bytes = 0;
        const auto slot = CompileArmRegion(json.c_str(), layout, &bytes);
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
void Jit::ClearExclusiveState() { impl->state.exclusive = false; }
void Jit::DumpDisassembly() const { throw std::runtime_error("Wasm disassembly is unavailable"); }
std::vector<std::string> Jit::Disassemble() const { throw std::runtime_error("Wasm disassembly is unavailable"); }
} // namespace Dynarmic::A32
