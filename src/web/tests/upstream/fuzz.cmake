# SPDX-License-Identifier: GPL-2.0-or-later

include(ExternalProject)
set(UNICORN_ORACLE_TOOLCHAIN)
set(UNICORN_ORACLE_DOWNLOAD
    GIT_REPOSITORY https://origin.cursor.com/mov/unicorn-stellite-wasm.git
    GIT_TAG 1eeed616346c4c44cb6e69877bea193cf9f2ef34)
if(EMSCRIPTEN)
    set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-wasm-oracle")
    set(UNICORN_ORACLE_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/unicorn-wasm-source")
    list(APPEND UNICORN_ORACLE_TOOLCHAIN
        "-DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}"
        "-DCMAKE_C_FLAGS=-fwasm-exceptions")
else()
    # The fork also fixes the native AArch64 oracle's single-lane encodings.
    set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-oracle")
    set(UNICORN_ORACLE_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-source")
    if(APPLE)
        list(APPEND UNICORN_ORACLE_TOOLCHAIN
            "-DCMAKE_OSX_ARCHITECTURES=${CMAKE_HOST_SYSTEM_PROCESSOR}")
    endif()
endif()
ExternalProject_Add(unicorn_test_oracle
    SOURCE_DIR "${UNICORN_ORACLE_SOURCE}"
    ${UNICORN_ORACLE_DOWNLOAD}
    GIT_SUBMODULES ""
    BINARY_DIR "${UNICORN_ORACLE_BINARY}"
    CMAKE_ARGS -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
        -DUNICORN_ARCH=arm -DUNICORN_BUILD_TESTS=OFF -DUNICORN_INSTALL=OFF
        -DUNICORN_LEGACY_STATIC_ARCHIVE=ON ${UNICORN_ORACLE_TOOLCHAIN}
    BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR>
        --target unicorn_archive --parallel 4
    BUILD_BYPRODUCTS "${UNICORN_ORACLE_BINARY}/libunicorn.a"
    INSTALL_COMMAND "")
add_library(azahar_unicorn_test_oracle STATIC IMPORTED)
set_target_properties(azahar_unicorn_test_oracle PROPERTIES
    IMPORTED_LOCATION "${UNICORN_ORACLE_BINARY}/libunicorn.a")
add_dependencies(azahar_unicorn_test_oracle unicorn_test_oracle)

add_executable(dynarmic_arm_fuzz_fixtures
    fuzz-runtime.cpp "${DYNARMIC_ROOT}/tests/fuzz_util.cpp")
target_include_directories(dynarmic_arm_fuzz_fixtures PRIVATE
    "${UNICORN_ORACLE_SOURCE}/include" "${DYNARMIC_ROOT}/tests")
target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE
    azahar_unicorn_test_oracle Catch2::Catch2WithMain)
target_sources(dynarmic_arm_fuzz_fixtures PRIVATE
    "${DYNARMIC_ROOT}/tests/A32/fuzz_arm.cpp"
    "${DYNARMIC_ROOT}/tests/A32/fuzz_thumb.cpp"
    "${DYNARMIC_ROOT}/tests/unicorn_emu/a32_unicorn.cpp")
if(EMSCRIPTEN)
    target_sources(dynarmic_arm_fuzz_fixtures PRIVATE
        "${DYNARMIC_ROOT}/src/dynarmic/common/llvm_disassemble.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/disassembler/disassembler_thumb.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/ir/opt/naming_pass.cpp")
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE azahar_arm_jit)
    target_link_options(dynarmic_arm_fuzz_fixtures PRIVATE
        -g2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_arm_fuzz_fixtures PROPERTIES SUFFIX ".mjs")
    add_test(NAME dynarmic_arm_fuzz_fixtures COMMAND "${BUN_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/run-jit.ts" "$<TARGET_FILE:dynarmic_arm_fuzz_fixtures>")
    add_dependencies(browser_jit_fixtures dynarmic_arm_fuzz_fixtures)
else()
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE
        dynarmic Boost::boost merry::mcl fmt::fmt)
    register_fixture(dynarmic_arm_fuzz_fixtures)
endif()
add_dependencies(upstream_fixtures dynarmic_arm_fuzz_fixtures)
