# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.25)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "The ARM Wasm JIT requires the Emscripten toolchain")
endif()
get_filename_component(AZAHAR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(DYNARMIC_ROOT "${AZAHAR_ROOT}/externals/dynarmic")
if(NOT TARGET azahar_arm_frontend)
    add_subdirectory("${AZAHAR_ROOT}/src/web/compiler" "${CMAKE_CURRENT_BINARY_DIR}/frontend" EXCLUDE_FROM_ALL)
endif()

add_library(azahar_arm_jit STATIC
    jit.cpp
    spin_lock.cpp
    "${DYNARMIC_ROOT}/src/dynarmic/common/crypto/aes.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/crypto/crc32.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/math_util.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/backend/arm64/exclusive_monitor.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/fused.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPMulAdd.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPCompare.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPConvert.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPRoundInt.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPRecipEstimate.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPRecipStepFused.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPRSqrtEstimate.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPRSqrtStepFused.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/op/FPToFixed.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/process_exception.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/process_nan.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/fp/unpacked.cpp")
target_link_libraries(azahar_arm_jit PUBLIC azahar_arm_frontend)
target_compile_features(azahar_arm_jit PUBLIC cxx_std_20)
target_compile_options(azahar_arm_jit PRIVATE -O3 PUBLIC -msimd128 -fwasm-exceptions)
target_link_options(azahar_arm_jit INTERFACE
    -fwasm-exceptions -sALLOW_TABLE_GROWTH=1 -Wl,--export-table
    "-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=['$stringToNewUTF8','$UTF8ToString']")
