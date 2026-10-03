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

find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
set(DSP_HOST_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-dsp-jit.js")
add_custom_command(OUTPUT "${DSP_HOST_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/jit-host.ts"
        --target browser --outfile "${DSP_HOST_OUTPUT}"
    DEPENDS jit-host.ts ../package.json ../bun.lock
    VERBATIM)
add_custom_target(azahar_dsp_jit_host DEPENDS "${DSP_HOST_OUTPUT}")

function(azahar_add_dsp_execution target)
    get_filename_component(dsp_root "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/../../.." ABSOLUTE)
    target_sources(${target} PRIVATE "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/jit.cpp")
    target_include_directories(${target} PRIVATE "${dsp_root}/externals/teakra/src"
        "${dsp_root}/externals/teakra/include/teakra/impl")
endfunction()

function(azahar_enable_dsp_runtime target)
    target_link_libraries(${target} PRIVATE "$<TARGET_FILE:azahar_dsp_templates>")
    add_dependencies(${target} azahar_dsp_templates azahar_dsp_jit_host)
    target_link_options(${target} PRIVATE -sMAIN_MODULE=2 -Wl,--export=__stack_pointer
        -Wl,--export=malloc -Wl,--export=free
        "SHELL:--js-library \"${CMAKE_CURRENT_FUNCTION_LIST_DIR}/runtime.js\"")
    set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/runtime.js")
endfunction()
