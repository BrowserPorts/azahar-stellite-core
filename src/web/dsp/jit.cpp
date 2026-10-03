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
}

EM_JS_DEPS(dsp_jit, "$GOT,$stringToNewUTF8,$initializeDspRuntime");

EM_JS(void, InitializeDspJit,
      (const char* json, u8* flags, u32 register_size, u32 semantics_size, u32 memory_size), {
    const imports = {
        env: Object.assign({}, wasmImports, wasmExports, {
            memory: wasmMemory, __indirect_function_table: wasmExports["__indirect_function_table"]
        }),
        "GOT.mem": GOT, "GOT.func": GOT
    };
    const result = Module["azaharDspJitHost"].bind(
        UTF8ToString(json),
        [register_size, semantics_size, memory_size], wasmMemory,
        wasmExports["__indirect_function_table"], imports);
    HEAPU8.set(result, flags);
});

EM_JS(u32, CompileDspInstruction, (u32 opcode, u32 expansion), {
    try { return Module["azaharDspJitHost"].compile(opcode, expansion); }
    catch (error) {
        Module["azaharDspCompileError"] = "DSP opcode " + opcode.toString(16) + ": " + String(error);
        err(Module["azaharDspCompileError"]);
        return 0;
    }
});
EM_JS(char*, DspCompileError, (), {
    return stringToNewUTF8(Module["azaharDspCompileError"] || "DSP compilation failed");
});

extern "C" {
EMSCRIPTEN_KEEPALIVE uint32_t azahar_dsp_jit_entries() {
    return installed_entries.load(std::memory_order_relaxed);
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
        std::array<u8, 65536> result{};
        InitializeDspJit(azahar_dsp_template_metadata(), result.data(),
                         sizeof(Teakra::RegisterState), sizeof(Web::Dsp::Semantics),
                         sizeof(Web::Dsp::MemoryAccess));
        return result;
    }();
    return flags;
}

using Entry = void (*)(Web::Dsp::Semantics*);

std::unordered_map<u32, Entry>& ThreadEntries() {
    // Each Wasm thread owns its function table; generated slots stay on that thread.
    static thread_local std::unordered_map<u32, Entry> entries;
    return entries;
}

// The original timing, repeat and interrupt scheduler drives generated Wasm entries.
class WasmExecution final : public Teakra::ExecutionBackend, public Web::Dsp::Semantics {
public:
    WasmExecution(Teakra::CoreTiming& timing, Teakra::RegisterState& registers,
                  Teakra::MemoryInterface& memory)
        : Web::Dsp::Semantics(registers, access), core_timing(timing), memory(memory),
          access{reinterpret_cast<uint32_t>(&memory)} {
        OpcodeFlags();
    }

    void Run(u64 cycles) override {
        const auto& opcode_flags = OpcodeFlags();
        auto& entries = ThreadEntries();
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
            const u32 key = (static_cast<u32>(opcode) << 16) | expand_value;
            auto entry = entries.find(key);
            if (entry == entries.end()) {
                const u32 slot = CompileDspInstruction(opcode, expand_value);
                if (!slot) {
                    char* error = DspCompileError();
                    const std::string message(error ? error : "DSP compilation failed");
                    std::free(error);
                    throw std::runtime_error(message);
                }
                entry = entries.emplace(key, reinterpret_cast<Entry>(slot)).first;
                installed_entries.fetch_add(1, std::memory_order_relaxed);
            }
            entry->second(static_cast<Web::Dsp::Semantics*>(this));

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

private:
    Teakra::CoreTiming& core_timing;
    Teakra::MemoryInterface& memory;
    Web::Dsp::MemoryAccess access;
    std::array<std::atomic<bool>, 3> interrupt_pending{{false, false, false}};
    std::atomic<bool> vinterrupt_pending{false};
    std::atomic<bool> vinterrupt_context_switch;
    std::atomic<u32> vinterrupt_address;
};

} // namespace

namespace Teakra {
std::unique_ptr<ExecutionBackend> CreateExecutionBackend(CoreTiming& core_timing, RegisterState& regs,
                                                       MemoryInterface& memory) {
    return std::make_unique<WasmExecution>(core_timing, regs, memory);
}
} // namespace Teakra
