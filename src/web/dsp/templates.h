// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <cstdint>
#include "instruction_semantics.h"

extern "C" {
uint16_t azahar_dsp_data_read(uint32_t context, uint16_t address);
void azahar_dsp_data_write(uint32_t context, uint16_t address, uint16_t value);
uint16_t azahar_dsp_program_read(uint32_t context, uint32_t address);
void azahar_dsp_program_write(uint32_t context, uint32_t address, uint16_t value);
}

namespace Web::Dsp {

// Opcode templates carry the native memory interface through an explicit context.
// Compiled blocks import these four operations for DSP memory and MMIO access.
struct MemoryAccess {
    uint32_t context;

    uint16_t DataRead(uint16_t address) {
        return azahar_dsp_data_read(context, address);
    }
    void DataWrite(uint16_t address, uint16_t value) {
        azahar_dsp_data_write(context, address, value);
    }
    uint16_t ProgramRead(uint32_t address) {
        return azahar_dsp_program_read(context, address);
    }
    void ProgramWrite(uint32_t address, uint16_t value) {
        azahar_dsp_program_write(context, address, value);
    }
};

using Semantics = Teakra::InstructionSemantics<MemoryAccess>;

} // namespace Web::Dsp
