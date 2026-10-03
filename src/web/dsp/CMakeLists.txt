# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.25)
project(azahar_dsp_templates LANGUAGES CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "DSP Wasm templates require the Emscripten toolchain")
endif()
get_filename_component(AZAHAR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(TEAKRA_ROOT "${AZAHAR_ROOT}/externals/teakra")

# This side module supplies compilation inputs, with the original opcode bodies.
# These bodies are the inputs for block specialization, without a decoder loop.
add_executable(azahar_dsp_templates templates.cpp templates.h)
target_compile_features(azahar_dsp_templates PRIVATE cxx_std_20)
target_include_directories(azahar_dsp_templates PRIVATE
    "${TEAKRA_ROOT}/src" "${TEAKRA_ROOT}/include/teakra/impl")
target_compile_options(azahar_dsp_templates PRIVATE -O3 -fwasm-exceptions)
target_link_options(azahar_dsp_templates PRIVATE
    -O3 -fwasm-exceptions -sSIDE_MODULE=2 --no-entry --profiling-funcs)
set_target_properties(azahar_dsp_templates PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    OUTPUT_NAME "azahar-dsp-templates" SUFFIX ".wasm"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
