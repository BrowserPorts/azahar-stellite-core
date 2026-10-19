// SPDX-License-Identifier: GPL-2.0-or-later
// Scheduler adapted from Teakra, Copyright (c) 2018 Weiyi Wang.
// See externals/teakra/LICENSE for the original MIT license.

#include <array>
#include <atomic>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <emscripten.h>
#include "core_timing.h"
#include "execution_backend.h"
#include "memory_interface.h"
#include "templates.h"

extern "C" const char* azahar_dsp_template_metadata();

namespace {
std::atomic<uint32_t> installed_entries{0};
std::atomic<uint32_t> optimized_entries{0};
std::atomic<uint64_t> initialization_us{0};
std::atomic<uint64_t> cold_compile_us{0};
std::atomic<uint64_t> optimized_compile_us{0};
constexpr uint32_t optimize_after = AZAHAR_DSP_JIT_OPTIMIZE_AFTER;
thread_local uint32_t* optimization_ready = nullptr;
[[noreturn]] void ThrowCompileError();
}

EM_JS_DEPS(dsp_jit, "$GOT,$stringToNewUTF8,$initializeDspRuntime");

EM_JS(bool, DspJitReady, (), {
    return Boolean(Module["azaharDspJitHost"]);
});

EM_ASYNC_JS(bool, PrepareDspJit, (), {
    try {
        await initializeDspRuntime();
        return true;
    } catch (error) {
        Module["azaharDspCompileError"] = "DSP compiler initialization failed: " + String(error);
        return false;
    }
});

EM_ASYNC_JS(u32, InitializeDspJit,
      (const char* json, u8* flags, u32 register_size, u32 semantics_size, u32 memory_size), {
    try {
        const imports = {
            env: Object.assign({}, wasmImports, wasmExports, {
                memory: wasmMemory, __indirect_function_table: wasmExports["__indirect_function_table"]
            }),
            "GOT.mem": GOT, "GOT.func": GOT
        };
        const result = await Module["azaharDspJitHost"].bind(
            UTF8ToString(json),
            [register_size, semantics_size, memory_size], wasmMemory,
            wasmExports["__indirect_function_table"], imports);
        HEAPU8.set(result, flags);
        return Module["azaharDspJitHost"].readyPointer;
    } catch (error) {
        Module["azaharDspCompileError"] = "DSP compiler binding failed: " + String(error);
        return 0;
    }
});

EM_JS(u32, CompileDspInstruction, (u32 opcode, u32 expansion), {
    try { return Module["azaharDspJitHost"].compile(opcode, expansion); }
    catch (error) {
        Module["azaharDspCompileError"] = "DSP opcode " + opcode.toString(16) + ": " + String(error);
        err(Module["azaharDspCompileError"]);
        return 0;
    }
});
EM_JS(bool, RequestDspOptimization, (u32 opcode, u32 expansion), {
    try {
        Module["azaharDspJitHost"].requestOptimization(opcode, expansion);
        return true;
    } catch (error) {
        Module["azaharDspCompileError"] = "DSP optimization: " + String(error);
        return false;
    }
});
EM_ASYNC_JS(u32, OptimizeDspInstruction, (u32 opcode, u32 expansion), {
    try { return await Module["azaharDspJitHost"].optimize(opcode, expansion); }
    catch (error) {
        Module["azaharDspCompileError"] = "DSP optimization: " + String(error);
        return 0;
    }
});
EM_JS(int, PollDspOptimizations, (double* elapsed_ms), {
    try {
        const result = Module["azaharDspJitHost"].takeOptimizations();
        if (!result) return 0;
        HEAPF64[elapsed_ms >>> 3] = result.elapsedMs;
        return result.count;
    } catch (error) {
        Module["azaharDspCompileError"] = "DSP optimization: " + String(error);
        return -1;
    }
});
EM_JS(void, StopDspOptimization, (), {
    Module["azaharDspJitHost"]?.stopOptimization();
});
EM_JS(char*, DspCompileError, (), {
    return stringToNewUTF8(Module["azaharDspCompileError"] || "DSP compilation failed");
});

extern "C" {
EMSCRIPTEN_KEEPALIVE uint32_t azahar_dsp_jit_entries() {
    return installed_entries.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE uint32_t azahar_dsp_jit_optimized_entries() {
    return optimized_entries.load(std::memory_order_relaxed);
}
EMSCRIPTEN_KEEPALIVE double azahar_dsp_jit_initialization_ms() {
    return initialization_us.load(std::memory_order_relaxed) / 1000.0;
}
EMSCRIPTEN_KEEPALIVE double azahar_dsp_jit_cold_compile_ms() {
    return cold_compile_us.load(std::memory_order_relaxed) / 1000.0;
}
EMSCRIPTEN_KEEPALIVE double azahar_dsp_jit_optimized_compile_ms() {
    return optimized_compile_us.load(std::memory_order_relaxed) / 1000.0;
}
EMSCRIPTEN_KEEPALIVE uint16_t azahar_dsp_data_read(uint32_t context, uint16_t address) {
    return reinterpret_cast<Teakra::MemoryInterface*>(context)->DataRead(address);
}
EMSCRIPTEN_KEEPALIVE void azahar_dsp_data_write(uint32_t context, uint16_t address, uint16_t value) {
    reinterpret_cast<Teakra::MemoryInterface*>(context)->DataWrite(address, value);
}
EMSCRIPTEN_KEEPALIVE uint16_t azahar_dsp_program_read(uint32_t context, uint32_t address) {
    return reinterpret_cast<Teakra::MemoryInterface*>(context)->ProgramRead(address);
}
EMSCRIPTEN_KEEPALIVE void azahar_dsp_program_write(uint32_t context, uint32_t address, uint16_t value) {
    reinterpret_cast<Teakra::MemoryInterface*>(context)->ProgramWrite(address, value);
}
}

namespace {

const std::array<u8, 65536>& OpcodeFlags() {
    static thread_local const auto flags = [] {
        const double started = emscripten_get_now();
        // Pooled workers load the compiler only when they first execute DSP code.
        // Emscripten invokes pthread entries through a JSPI promising export.
        if (!DspJitReady() && !PrepareDspJit()) {
            char* error = DspCompileError();
            const std::string message(error ? error : "DSP compiler initialization failed");
            std::free(error);
            throw std::runtime_error(message);
        }
        std::array<u8, 65536> result{};
        const u32 signal = InitializeDspJit(azahar_dsp_template_metadata(), result.data(),
                                           sizeof(Teakra::RegisterState),
                                           sizeof(Web::Dsp::Semantics),
                                           sizeof(Web::Dsp::MemoryAccess));
        if (!signal) {
            ThrowCompileError();
        }
        optimization_ready = reinterpret_cast<uint32_t*>(signal);
        initialization_us.fetch_add(
            static_cast<uint64_t>((emscripten_get_now() - started) * 1000),
            std::memory_order_relaxed);
        return result;
    }();
    return flags;
}

using Entry = void (*)(Web::Dsp::Semantics*);

struct CompiledEntry {
    Entry function;
    u32 executions = 0;
    bool promotion_requested = false;
};

struct CachedEntry {
    CompiledEntry* compiled = nullptr;
    u16 expansion = 0;
};

struct EntryCache {
    std::array<CachedEntry, 65536> recent{};
    // References to map entries remain valid when the map rehashes.
    std::unordered_map<u32, CompiledEntry> specializations;

    ~EntryCache() {
        // Native pool workers keep their JS realm after a pthread exits.
        StopDspOptimization();
    }
};

EntryCache& ThreadEntries() {
    // Each Wasm thread owns its function table; generated slots stay on that thread.
    static thread_local EntryCache entries;
    return entries;
}

[[noreturn]] void ThrowCompileError() {
    char* error = DspCompileError();
    const std::string message(error ? error : "DSP compilation failed");
    std::free(error);
    throw std::runtime_error(message);
}

void PollOptimizations() {
    // Avoid a Wasm-to-JavaScript transition on DSP slices with no completed work.
    if (!optimization_ready || !__atomic_load_n(optimization_ready, __ATOMIC_RELAXED)) return;
    double elapsed_ms = 0;
    const int count = PollDspOptimizations(&elapsed_ms);
    if (count < 0) ThrowCompileError();
    if (count) {
        optimized_entries.fetch_add(count, std::memory_order_relaxed);
        optimized_compile_us.fetch_add(static_cast<uint64_t>(elapsed_ms * 1000),
                                       std::memory_order_relaxed);
    }
}

Entry Compile(u16 opcode, u16 expansion) {
    const double started = emscripten_get_now();
    const u32 slot = CompileDspInstruction(opcode, expansion);
    cold_compile_us.fetch_add(static_cast<uint64_t>((emscripten_get_now() - started) * 1000),
                             std::memory_order_relaxed);
    if (slot) return reinterpret_cast<Entry>(slot);
    ThrowCompileError();
}

// The original timing, repeat and interrupt scheduler drives generated Wasm entries.
class WasmExecution final : public Teakra::ExecutionBackend, public Web::Dsp::Semantics {
public:
    WasmExecution(Teakra::CoreTiming& timing, Teakra::RegisterState& registers,
                  Teakra::MemoryInterface& memory)
        : Web::Dsp::Semantics(registers, access), core_timing(timing), memory(memory),
          access{reinterpret_cast<uint32_t>(&memory)} {}

    void Run(u64 cycles) override {
        const auto& opcode_flags = OpcodeFlags();
        auto& entries = ThreadEntries();
        PollOptimizations();
        idle = false;
        for (u64 i = 0; i < cycles; ++i) {
            if (idle) {
                u64 skipped = core_timing.Skip(cycles - i - 1);
                i += skipped;

                // Skip additional tick so to let components fire interrupts
                if (i < cycles - 1) {
                    ++i;
                    core_timing.Tick();
                }
            }

            for (std::size_t i = 0; i < 3; ++i) {
                if (interrupt_pending[i].exchange(false)) {
                    regs.ip[i] = 1;
                }
            }

            if (vinterrupt_pending.exchange(false)) {
                regs.ipv = 1;
            }

            u16 opcode = memory.ProgramRead((regs.pc++) | (regs.prpage << 18));
            const auto flags = opcode_flags[opcode];
            u16 expand_value = 0;
            if (flags == 2) {
                expand_value = memory.ProgramRead((regs.pc++) | (regs.prpage << 18));
            }

            if (regs.rep) {
                if (regs.repc == 0) {
                    regs.rep = false;
                } else {
                    --regs.repc;
                    --regs.pc;
                }
            }

            if (regs.lp && regs.bkrep_stack[regs.bcn - 1].end + 1 == regs.pc) {
                if (regs.bkrep_stack[regs.bcn - 1].lc == 0) {
                    --regs.bcn;
                    regs.lp = regs.bcn != 0;
                } else {
                    --regs.bkrep_stack[regs.bcn - 1].lc;
                    regs.pc = regs.bkrep_stack[regs.bcn - 1].start;
                }
            }

            if (!flags) Teakra::ThrowUnimplemented();
            auto& recent = entries.recent[opcode];
            CompiledEntry* entry = recent.compiled;
            if (!entry || recent.expansion != expand_value) {
                const u32 key = (static_cast<u32>(opcode) << 16) | expand_value;
                auto found = entries.specializations.find(key);
                if (found == entries.specializations.end()) {
                    const auto function = Compile(opcode, expand_value);
                    found = entries.specializations
                                .emplace(key, CompiledEntry{function})
                                .first;
                    installed_entries.fetch_add(1, std::memory_order_relaxed);
                }
                entry = &found->second;
                recent = {entry, expand_value};
            }
            if (!entry->promotion_requested && ++entry->executions >= optimize_after) {
                if constexpr (optimize_after <= 1) {
                    const u32 slot = OptimizeDspInstruction(opcode, expand_value);
                    if (!slot) ThrowCompileError();
                    entry->function = reinterpret_cast<Entry>(slot);
                    PollOptimizations();
                } else {
                    if (!RequestDspOptimization(opcode, expand_value)) ThrowCompileError();
                }
                entry->promotion_requested = true;
            }
            entry->function(static_cast<Web::Dsp::Semantics*>(this));

            // I am not sure if a single-instruction loop is interruptable and how it is handled,
            // so just disable interrupt for it for now.
            if (regs.ie && !regs.rep) {
                bool interrupt_handled = false;
                for (u32 i = 0; i < regs.im.size(); ++i) {
                    if (regs.im[i] && regs.ip[i]) {
                        regs.ip[i] = 0;
                        regs.ie = 0;
                        PushPC();
                        regs.pc = 0x0006 + i * 8;
                        idle = false;
                        interrupt_handled = true;
                        if (regs.ic[i]) {
                            ContextStore();
                        }
                        break;
                    }
                }
                if (!interrupt_handled && regs.imv && regs.ipv) {
                    regs.ipv = 0;
                    regs.ie = 0;
                    PushPC();
                    regs.pc = vinterrupt_address;
                    idle = false;
                    if (vinterrupt_context_switch) {
                        ContextStore();
                    }
                }
            }

            core_timing.Tick();
        }
    }

    void SignalInterrupt(u32 i) override {
        interrupt_pending[i] = true;
    }
    void SignalVectoredInterrupt(u32 address, bool context_switch) override {
        vinterrupt_address = address;
        vinterrupt_pending = true;
        vinterrupt_context_switch = context_switch;
    }

    Teakra::ExecutionState CaptureState() const override {
        Teakra::ExecutionState state;
        state.idle = idle;
        for (std::size_t i = 0; i < interrupt_pending.size(); ++i)
            state.interrupt_pending[i] = interrupt_pending[i].load(std::memory_order_relaxed);
        state.vectored_pending = vinterrupt_pending.load(std::memory_order_relaxed);
        state.vectored_context_switch = vinterrupt_context_switch.load(std::memory_order_relaxed);
        state.vectored_address = vinterrupt_address.load(std::memory_order_relaxed);
        return state;
    }

    void RestoreState(const Teakra::ExecutionState& state) override {
        idle = state.idle;
        for (std::size_t i = 0; i < interrupt_pending.size(); ++i)
            interrupt_pending[i].store(state.interrupt_pending[i], std::memory_order_relaxed);
        vinterrupt_pending.store(state.vectored_pending, std::memory_order_relaxed);
        vinterrupt_context_switch.store(state.vectored_context_switch, std::memory_order_relaxed);
        vinterrupt_address.store(state.vectored_address, std::memory_order_relaxed);
    }

private:
    Teakra::CoreTiming& core_timing;
    Teakra::MemoryInterface& memory;
    Web::Dsp::MemoryAccess access;
    std::array<std::atomic<bool>, 3> interrupt_pending{{false, false, false}};
    std::atomic<bool> vinterrupt_pending{false};
    std::atomic<bool> vinterrupt_context_switch{false};
    std::atomic<u32> vinterrupt_address{0};
};

} // namespace

namespace Teakra {
std::unique_ptr<ExecutionBackend> CreateExecutionBackend(CoreTiming& core_timing, RegisterState& regs,
                                                       MemoryInterface& memory) {
    return std::make_unique<WasmExecution>(core_timing, regs, memory);
}
} // namespace Teakra
