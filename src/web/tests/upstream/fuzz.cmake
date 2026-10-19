# SPDX-License-Identifier: GPL-2.0-or-later

include(ExternalProject)
# CMake caches its toolchain include in CMakeSystem.cmake. Separate compiler
# selections so incremental builds can retain that configuration safely.
file(REAL_PATH "${CMAKE_C_COMPILER}" UNICORN_ORACLE_COMPILER)
set(UNICORN_ORACLE_TOOLCHAIN_PATH "")
if(CMAKE_TOOLCHAIN_FILE)
    file(REAL_PATH "${CMAKE_TOOLCHAIN_FILE}" UNICORN_ORACLE_TOOLCHAIN_PATH)
endif()
string(SHA256 UNICORN_ORACLE_CONFIGURATION
    "${UNICORN_ORACLE_COMPILER};${CMAKE_C_COMPILER_VERSION};${CMAKE_SYSTEM_NAME};${CMAKE_SYSTEM_PROCESSOR};${UNICORN_ORACLE_TOOLCHAIN_PATH}")
string(SUBSTRING "${UNICORN_ORACLE_CONFIGURATION}" 0 12 UNICORN_ORACLE_CONFIGURATION)
set(UNICORN_ORACLE_TOOLCHAIN)
set(UNICORN_ORACLE_DOWNLOAD
    GIT_REPOSITORY https://origin.cursor.com/mov/unicorn-stellite-wasm.git
    GIT_TAG 7e1831168fcd576e6715a7092e55c09fc8999d90)
if(EMSCRIPTEN)
    set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-wasm-oracle-${UNICORN_ORACLE_CONFIGURATION}")
    set(UNICORN_ORACLE_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/unicorn-wasm-source")
    set(UNICORN_ORACLE_C_FLAGS "${CMAKE_C_FLAGS} -fwasm-exceptions")
    if(AZAHAR_TEAKRA_JIT OR AZAHAR_ARM_JIT_THREADS)
        string(APPEND UNICORN_ORACLE_C_FLAGS " -pthread")
    endif()
    list(APPEND UNICORN_ORACLE_TOOLCHAIN
        "-DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}"
        "-DCMAKE_CROSSCOMPILING_EMULATOR=${NODE_EXECUTABLE}"
        "-DCMAKE_C_FLAGS=${UNICORN_ORACLE_C_FLAGS}"
        "-DCMAKE_EXE_LINKER_FLAGS=-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 -sEXIT_RUNTIME=1")
    set(UNICORN_ORACLE_ARM_TEST "${UNICORN_ORACLE_BINARY}/test_arm.js")
else()
    # The fork also fixes the native AArch64 oracle's single-lane encodings.
    set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-oracle-${UNICORN_ORACLE_CONFIGURATION}")
    set(UNICORN_ORACLE_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-source")
    set(UNICORN_ORACLE_ARM_TEST "${UNICORN_ORACLE_BINARY}/test_arm${CMAKE_EXECUTABLE_SUFFIX}")
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
        -DUNICORN_ARCH=arm -DUNICORN_BUILD_TESTS=ON -DUNICORN_INSTALL=OFF
        -DUNICORN_LEGACY_STATIC_ARCHIVE=ON ${UNICORN_ORACLE_TOOLCHAIN}
    BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR>
        --target unicorn_archive test_arm --parallel 4
    BUILD_BYPRODUCTS "${UNICORN_ORACLE_BINARY}/libunicorn.a" "${UNICORN_ORACLE_ARM_TEST}"
    INSTALL_COMMAND "")
add_test(NAME unicorn_arm_fixtures COMMAND "${CMAKE_CTEST_COMMAND}"
    --test-dir "${UNICORN_ORACLE_BINARY}" -R "^test_arm$" --verbose --no-tests=error)
set_tests_properties(unicorn_arm_fixtures PROPERTIES TIMEOUT 60)
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
        disassemble.cpp
        "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/disassembler/disassembler_arm.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/disassembler/disassembler_thumb.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/ir/opt/naming_pass.cpp")
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE azahar_arm_jit)
    target_link_options(dynarmic_arm_fuzz_fixtures PRIVATE
        -g2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912
        -sEXPORTED_RUNTIME_METHODS=FS,ENV)
    set_target_properties(dynarmic_arm_fuzz_fixtures PROPERTIES SUFFIX ".mjs"
        CROSSCOMPILING_EMULATOR "${NODE_EXECUTABLE};${ARM_JIT_RUNNER}")
    add_dependencies(dynarmic_arm_fuzz_fixtures arm_jit_fixture_runner)
    add_dependencies(browser_jit_fixtures dynarmic_arm_fuzz_fixtures)
else()
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE
        dynarmic Boost::boost merry::mcl fmt::fmt)
endif()
include("${AZAHAR_ROOT}/externals/catch2/extras/Catch.cmake")
catch_discover_tests(dynarmic_arm_fuzz_fixtures
    TEST_PREFIX "dynarmic_arm_fuzz_fixtures::"
    DISCOVERY_MODE PRE_TEST
    PROPERTIES TIMEOUT 1500)
add_dependencies(upstream_fixtures dynarmic_arm_fuzz_fixtures)
