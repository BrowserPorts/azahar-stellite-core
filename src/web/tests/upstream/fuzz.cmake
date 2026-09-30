# SPDX-License-Identifier: GPL-2.0-or-later

include(ExternalProject)
set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-oracle")
set(UNICORN_ORACLE_TOOLCHAIN)
set(UNICORN_ORACLE_DOWNLOAD)
if(EMSCRIPTEN)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/prepare-unicorn.py"
        "${CMAKE_CURRENT_SOURCE_DIR}/adapt-unicorn.py"
        "${DYNARMIC_ROOT}/tests/A32/fuzz_arm.cpp"
        "${DYNARMIC_ROOT}/tests/A32/fuzz_thumb.cpp"
        "${DYNARMIC_ROOT}/tests/unicorn_emu/a32_unicorn.h"
        "${DYNARMIC_ROOT}/tests/unicorn_emu/a32_unicorn.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/common/llvm_disassemble.cpp")
    include(FetchContent)
    FetchContent_Declare(unicorn_js
        GIT_REPOSITORY https://github.com/AlexAltea/unicorn.js.git
        GIT_TAG 1220477c7fb0f8fe4b500f4bd211de52f6dfe638
        GIT_SUBMODULES unicorn
        GIT_SUBMODULES_RECURSE FALSE)
    FetchContent_MakeAvailable(unicorn_js)
    set(UNICORN_ORACLE_SOURCE "${unicorn_js_SOURCE_DIR}/unicorn")
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    execute_process(COMMAND "${Python3_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/prepare-unicorn.py" "${unicorn_js_SOURCE_DIR}"
        COMMAND_ERROR_IS_FATAL ANY)
    list(APPEND UNICORN_ORACLE_TOOLCHAIN
        "-DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}"
        "-DCMAKE_C_FLAGS=-fwasm-exceptions")
else()
    # Native comparisons use pristine Unicorn, without the Wasm ABI adapters.
    set(UNICORN_ORACLE_BINARY "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-oracle")
    set(UNICORN_ORACLE_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/unicorn-native-source")
    list(APPEND UNICORN_ORACLE_DOWNLOAD
        GIT_REPOSITORY https://github.com/unicorn-engine/unicorn.git
        GIT_TAG 8028ec436f2d9376525352dd38ed9ed6b9f6be10)
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

add_executable(dynarmic_arm_fuzz_fixtures "${DYNARMIC_ROOT}/tests/fuzz_util.cpp")
target_include_directories(dynarmic_arm_fuzz_fixtures PRIVATE
    "${UNICORN_ORACLE_SOURCE}/include")
target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE
    azahar_unicorn_test_oracle Catch2::Catch2WithMain)
if(EMSCRIPTEN)
    execute_process(COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/adapt-unicorn.py"
        "${DYNARMIC_ROOT}/tests" "${CMAKE_CURRENT_BINARY_DIR}/unicorn-harness"
        COMMAND_ERROR_IS_FATAL ANY)
    target_sources(dynarmic_arm_fuzz_fixtures PRIVATE
        "${CMAKE_CURRENT_BINARY_DIR}/unicorn-harness/fuzz_arm.cpp"
        "${CMAKE_CURRENT_BINARY_DIR}/unicorn-harness/fuzz_thumb.cpp"
        "${CMAKE_CURRENT_BINARY_DIR}/unicorn-harness/a32_unicorn.cpp")
    # Adapt pointer formatting in the diagnostic helper, retaining the native tests.
    file(READ "${DYNARMIC_ROOT}/src/dynarmic/common/llvm_disassemble.cpp" DISASSEMBLE_TEXT)
    foreach(POINTER IN ITEMS begin end)
        string(REPLACE "mcl::bit_cast<u64>(${POINTER})"
            "static_cast<u64>(reinterpret_cast<uintptr_t>(${POINTER}))"
            DISASSEMBLE_TEXT "${DISASSEMBLE_TEXT}")
    endforeach()
    file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/wasm_llvm_disassemble.cpp"
        CONTENT "${DISASSEMBLE_TEXT}" @ONLY)
    target_sources(dynarmic_arm_fuzz_fixtures PRIVATE
        "${CMAKE_CURRENT_BINARY_DIR}/wasm_llvm_disassemble.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/disassembler/disassembler_thumb.cpp"
        "${DYNARMIC_ROOT}/src/dynarmic/ir/opt/naming_pass.cpp")
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE azahar_arm_jit)
    target_link_options(dynarmic_arm_fuzz_fixtures PRIVATE
        -g2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node
        -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_arm_fuzz_fixtures PROPERTIES SUFFIX ".mjs")
    add_test(NAME dynarmic_arm_fuzz_fixtures COMMAND "${BUN_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/run-jit.ts" "$<TARGET_FILE:dynarmic_arm_fuzz_fixtures>")
    add_dependencies(browser_jit_fixtures dynarmic_arm_fuzz_fixtures)
else()
    target_sources(dynarmic_arm_fuzz_fixtures PRIVATE
        "${DYNARMIC_ROOT}/tests/A32/fuzz_arm.cpp"
        "${DYNARMIC_ROOT}/tests/A32/fuzz_thumb.cpp"
        "${DYNARMIC_ROOT}/tests/unicorn_emu/a32_unicorn.cpp")
    target_link_libraries(dynarmic_arm_fuzz_fixtures PRIVATE
        dynarmic Boost::boost merry::mcl fmt::fmt)
    register_fixture(dynarmic_arm_fuzz_fixtures)
endif()
add_dependencies(upstream_fixtures dynarmic_arm_fuzz_fixtures)
