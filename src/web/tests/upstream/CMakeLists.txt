# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.25)
project(azahar_upstream_fixtures LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
include(CTest)
get_filename_component(AZAHAR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)
set(DYNARMIC_ROOT "${AZAHAR_ROOT}/externals/dynarmic")

if(EMSCRIPTEN)
    add_compile_options(-fwasm-exceptions)
    add_link_options(-fwasm-exceptions -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304
        -sENVIRONMENT=node -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
endif()

set(CATCH_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(CATCH_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
set(CATCH_INSTALL_EXTRAS OFF CACHE BOOL "" FORCE)
set(CATCH_CONFIG_NO_POSIX_SIGNALS ON CACHE BOOL "" FORCE)
set(FMT_INSTALL OFF CACHE BOOL "" FORCE)
set(MCL_INSTALL OFF CACHE BOOL "" FORCE)
set(MCL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(MCL_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
if(NOT EMSCRIPTEN)
    set(FMT_INSTALL ON CACHE BOOL "" FORCE)
    set(MCL_INSTALL ON CACHE BOOL "" FORCE)
endif()
add_subdirectory("${AZAHAR_ROOT}/externals/catch2" "${CMAKE_CURRENT_BINARY_DIR}/catch2" EXCLUDE_FROM_ALL)
add_subdirectory("${AZAHAR_ROOT}/externals/fmt" "${CMAKE_CURRENT_BINARY_DIR}/fmt" EXCLUDE_FROM_ALL)
add_subdirectory("${DYNARMIC_ROOT}/externals/mcl" "${CMAKE_CURRENT_BINARY_DIR}/mcl" EXCLUDE_FROM_ALL)

function(register_fixture target)
    if(EMSCRIPTEN)
        set_target_properties(${target} PROPERTIES SUFFIX ".cjs")
        add_test(NAME ${target} COMMAND "${NODE_EXECUTABLE}" "$<TARGET_FILE:${target}>")
    else()
        add_test(NAME ${target} COMMAND ${target})
    endif()
endfunction()

# Use the native test sources directly, retaining their assertions and licenses.
add_executable(azahar_portable_fixtures
    "${AZAHAR_ROOT}/src/tests/common/bit_field.cpp"
    "${AZAHAR_ROOT}/src/tests/video_core/pica_types.cpp")
target_include_directories(azahar_portable_fixtures PRIVATE
    "${AZAHAR_ROOT}/src" "${AZAHAR_ROOT}/externals/boost")
target_link_libraries(azahar_portable_fixtures PRIVATE Catch2::Catch2WithMain)
register_fixture(azahar_portable_fixtures)

add_executable(dynarmic_fp_fixtures
    "${DYNARMIC_ROOT}/tests/fp/FPToFixed.cpp"
    "${DYNARMIC_ROOT}/tests/fp/FPValue.cpp"
    "${DYNARMIC_ROOT}/tests/fp/mantissa_util_tests.cpp"
    "${DYNARMIC_ROOT}/tests/fp/unpacked_tests.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/u128.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPToFixed.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/process_exception.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/process_nan.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/unpacked.cpp")
target_include_directories(dynarmic_fp_fixtures PRIVATE "${DYNARMIC_ROOT}/src")
target_link_libraries(dynarmic_fp_fixtures PRIVATE Catch2::Catch2WithMain fmt::fmt merry::mcl)
register_fixture(dynarmic_fp_fixtures)

# Teakra's reference interpreter is confined to this standalone test build.
# These fixtures establish the DSP oracle and do not validate a DSP JIT yet.
set(TEAKRA_BUILD_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(TEAKRA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(TEAKRA_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
set(TEAKRA_RUN_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory("${AZAHAR_ROOT}/externals/teakra" "${CMAKE_CURRENT_BINARY_DIR}/teakra" EXCLUDE_FROM_ALL)
add_executable(teakra_reference_fixtures
    "${AZAHAR_ROOT}/externals/teakra/tests/dma.cpp"
    "${AZAHAR_ROOT}/externals/teakra/tests/btdmp.cpp"
    "${AZAHAR_ROOT}/externals/teakra/tests/interpreter.cpp"
    "${AZAHAR_ROOT}/externals/teakra/tests/main.cpp"
    "${AZAHAR_ROOT}/externals/teakra/tests/timer.cpp")
target_include_directories(teakra_reference_fixtures PRIVATE
    "${AZAHAR_ROOT}/externals/teakra/include/teakra/impl"
    "${AZAHAR_ROOT}/externals/teakra/externals/catch")
target_link_libraries(teakra_reference_fixtures PRIVATE teakra)
target_compile_definitions(teakra_reference_fixtures PRIVATE CATCH_CONFIG_NO_POSIX_SIGNALS)
register_fixture(teakra_reference_fixtures)
add_custom_target(upstream_fixtures DEPENDS azahar_portable_fixtures dynarmic_fp_fixtures teakra_reference_fixtures)

if(EMSCRIPTEN)
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    add_subdirectory("${AZAHAR_ROOT}/src/web/arm" "${CMAKE_CURRENT_BINARY_DIR}/arm-jit" EXCLUDE_FROM_ALL)
    add_executable(dynarmic_arm_jit_fixtures
        "${DYNARMIC_ROOT}/tests/A32/test_arm_disassembler.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_arm_instructions.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_coprocessor.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_thumb_instructions.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_svc.cpp"
        "${DYNARMIC_ROOT}/tests/decoder_tests.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/disassembler/disassembler_arm.cpp")
    target_link_libraries(dynarmic_arm_jit_fixtures PRIVATE azahar_arm_jit Catch2::Catch2WithMain)
    target_link_options(dynarmic_arm_jit_fixtures PRIVATE
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node
        -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_arm_jit_fixtures PROPERTIES SUFFIX ".mjs")
    add_test(NAME dynarmic_arm_jit_fixtures COMMAND "${BUN_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/run-jit.ts" "$<TARGET_FILE:dynarmic_arm_jit_fixtures>")
    configure_file(browser-jit.html browser-jit.html COPYONLY)
    add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/browser-jit.js"
        COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/browser-jit.ts"
            --target browser --outfile "${CMAKE_CURRENT_BINARY_DIR}/browser-jit.js"
        DEPENDS browser-jit.ts "${AZAHAR_ROOT}/src/web/arm/jit-host.ts"
            "${AZAHAR_ROOT}/src/web/arm/lower.ts" "${AZAHAR_ROOT}/src/web/arm/ir.ts"
            "${AZAHAR_ROOT}/src/web/pica/jit-host.ts" "${AZAHAR_ROOT}/src/web/pica/lower.ts"
            "${AZAHAR_ROOT}/src/web/pica/control-flow.ts" "${AZAHAR_ROOT}/src/web/pica/instruction.ts"
            "${AZAHAR_ROOT}/src/web/wasm/binary.ts" "${AZAHAR_ROOT}/src/web/protocol.ts")
    add_custom_target(browser_jit_fixtures DEPENDS
        dynarmic_arm_jit_fixtures "${CMAKE_CURRENT_BINARY_DIR}/browser-jit.js")
    add_dependencies(upstream_fixtures dynarmic_arm_jit_fixtures)
else()
    set(DYNARMIC_TESTS OFF CACHE BOOL "" FORCE)
    set(DYNARMIC_FRONTENDS A32 CACHE STRING "" FORCE)
    set(DYNARMIC_USE_BUNDLED_EXTERNALS ON CACHE BOOL "" FORCE)
    set(DYNARMIC_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
    set(DYNARMIC_ENABLE_NO_EXECUTE_SUPPORT ON CACHE BOOL "" FORCE)
    set(Boost_NO_BOOST_CMAKE ON CACHE BOOL "" FORCE)
    set(Boost_INCLUDE_DIR "${AZAHAR_ROOT}/externals/boost" CACHE PATH "" FORCE)
    set(CMAKE_POLICY_DEFAULT_CMP0167 OLD)
    find_package(Boost 1.57 REQUIRED)
    add_subdirectory("${DYNARMIC_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/dynarmic" EXCLUDE_FROM_ALL)
    add_executable(dynarmic_arm_jit_fixtures
        "${DYNARMIC_ROOT}/tests/A32/test_arm_disassembler.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_arm_instructions.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_coprocessor.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_thumb_instructions.cpp"
        "${DYNARMIC_ROOT}/tests/A32/test_svc.cpp"
        "${DYNARMIC_ROOT}/tests/decoder_tests.cpp")
    target_link_libraries(dynarmic_arm_jit_fixtures PRIVATE
        dynarmic Boost::boost Catch2::Catch2WithMain merry::mcl fmt::fmt)
    register_fixture(dynarmic_arm_jit_fixtures)
    add_dependencies(upstream_fixtures dynarmic_arm_jit_fixtures)
endif()

add_executable(dynarmic_vfp_recordings run-vfp.cpp)
target_include_directories(dynarmic_vfp_recordings PRIVATE "${DYNARMIC_ROOT}/tests")
if(EMSCRIPTEN)
    target_link_libraries(dynarmic_vfp_recordings PRIVATE azahar_arm_jit)
    add_dependencies(browser_jit_fixtures dynarmic_vfp_recordings)
    target_link_options(dynarmic_vfp_recordings PRIVATE
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node
        -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_vfp_recordings PROPERTIES SUFFIX ".mjs")
    add_test(NAME dynarmic_vfp_recordings COMMAND "${BUN_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/run-jit.ts" "$<TARGET_FILE:dynarmic_vfp_recordings>")
else()
    target_link_libraries(dynarmic_vfp_recordings PRIVATE dynarmic merry::mcl fmt::fmt)
    register_fixture(dynarmic_vfp_recordings)
endif()
add_dependencies(upstream_fixtures dynarmic_vfp_recordings)
