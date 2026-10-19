# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.25)
project(azahar_upstream_fixtures LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
include(CTest)
get_filename_component(AZAHAR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)
option(AZAHAR_TEAKRA_JIT "Run original Teakra fixtures through the Wasm JIT" OFF)
option(AZAHAR_TEAKRA_JIT_THREADS "Execute original Teakra cases on a Wasm pthread" OFF)
option(AZAHAR_ARM_JIT_THREADS "Compile ARM fixtures with shared Wasm memory" OFF)
option(ENABLE_LTO "Compile Wasm fixtures with link time optimization" OFF)
set(DYNARMIC_ROOT "${AZAHAR_ROOT}/externals/dynarmic")

if(EMSCRIPTEN)
    if(ENABLE_LTO)
        add_compile_options(-flto)
        add_link_options(-flto)
    endif()
    add_compile_options(-fwasm-exceptions)
    add_link_options(-fwasm-exceptions -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304
        -sENVIRONMENT=node -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    if(AZAHAR_TEAKRA_JIT)
        execute_process(COMMAND "${NODE_EXECUTABLE}" -e
            "process.exit(typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' ? 0 : 1)"
            RESULT_VARIABLE NODE_JSPI_RESULT)
        if(NOT NODE_JSPI_RESULT EQUAL 0)
            message(FATAL_ERROR
                "The Teakra Wasm JIT fixtures require Node with WebAssembly JSPI. "
                "Set NODE_EXECUTABLE to a compatible Node executable.")
        endif()
    endif()
    if(AZAHAR_TEAKRA_JIT OR AZAHAR_ARM_JIT_THREADS)
        add_compile_options(-pthread)
        add_link_options(-pthread)
    endif()
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

# The same upstream cases can select either execution backend at link time.
if(AZAHAR_TEAKRA_JIT)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR "The Teakra Wasm JIT requires Emscripten")
    endif()
    set(TEAKRA_NATIVE_EXECUTION_BACKEND OFF CACHE BOOL "" FORCE)
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    add_subdirectory("${AZAHAR_ROOT}/src/web/dsp" "${CMAKE_CURRENT_BINARY_DIR}/dsp-templates")
    set(DSP_JIT_RUNNER "${CMAKE_CURRENT_BINARY_DIR}/run-dsp-jit.mjs")
    add_custom_command(OUTPUT "${DSP_JIT_RUNNER}"
        COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/run-dsp-jit.ts"
            --target node --outfile "${DSP_JIT_RUNNER}"
        DEPENDS run-dsp-jit.ts "${AZAHAR_ROOT}/src/web/dsp/jit-host.ts"
            "${AZAHAR_ROOT}/src/web/dsp/compiler.ts"
            "${AZAHAR_ROOT}/src/web/dsp/family-archive.ts"
            "${AZAHAR_ROOT}/src/web/dsp/relocations.ts"
            "${AZAHAR_ROOT}/src/web/dsp/fold-readonly-loads.js"
            "${AZAHAR_ROOT}/src/web/dsp/fold-readonly-loads.d.ts"
            "${AZAHAR_ROOT}/src/web/package.json" "${AZAHAR_ROOT}/src/web/bun.lock"
        VERBATIM)
    add_custom_target(dsp_jit_fixture_runner DEPENDS "${DSP_JIT_RUNNER}")
else()
    set(TEAKRA_NATIVE_EXECUTION_BACKEND ON CACHE BOOL "" FORCE)
endif()
function(link_dsp_jit target)
    azahar_add_dsp_execution(${target})
    azahar_enable_dsp_runtime(${target})
    add_dependencies(${target} dsp_jit_fixture_runner)
    target_link_options(${target} PRIVATE -sMODULARIZE=1 -sEXPORT_ES6=1
        -Wl,--export=__stack_pointer "-sEXPORTED_FUNCTIONS=['_main','_malloc','_free']"
        "-sEXPORTED_RUNTIME_METHODS=['callMain','getExceptionMessage']")
    set_target_properties(${target} PROPERTIES SUFFIX ".mjs"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>"
        CROSSCOMPILING_EMULATOR "${NODE_EXECUTABLE};${DSP_JIT_RUNNER}")
    if(AZAHAR_TEAKRA_JIT_THREADS)
        target_link_options(${target} PRIVATE -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=1)
    endif()
endfunction()
set(TEAKRA_BUILD_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(TEAKRA_BUILD_TOOLS ON CACHE BOOL "" FORCE)
set(TEAKRA_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
set(TEAKRA_RUN_TESTS ON CACHE BOOL "" FORCE)
set(TEAKRA_TEST_ASSETS_DIR "${CMAKE_CURRENT_BINARY_DIR}/teakra-assets" CACHE PATH
    "Directory containing Teakra's original hardware-recorded test corpus")
if(NOT EXISTS "${TEAKRA_TEST_ASSETS_DIR}/teaklite2_tests_result.bin")
    file(MAKE_DIRECTORY "${TEAKRA_TEST_ASSETS_DIR}")
    file(DOWNLOAD
        "https://media.githubusercontent.com/media/wwylele/teakra/3d697a18df504f4677b65129d9ab14c7c597e3eb/src/test_verifier/data/teaklite2_tests_result.bin"
        "${TEAKRA_TEST_ASSETS_DIR}/teaklite2_tests_result.bin"
        EXPECTED_HASH SHA256=baffcd4f805a7480d969401792443a34aa39f813b4f0ae49c6365f1d1f3ce120)
endif()
add_subdirectory("${AZAHAR_ROOT}/externals/teakra" "${CMAKE_CURRENT_BINARY_DIR}/teakra" EXCLUDE_FROM_ALL)
if(EMSCRIPTEN)
    # The original verifier streams the corpus through native stdio without embedding it in Wasm.
    set_target_properties(test_verifier PROPERTIES SUFFIX ".cjs"
        CROSSCOMPILING_EMULATOR "${NODE_EXECUTABLE}")
    target_link_options(test_verifier PRIVATE -sNODERAWFS=1)
endif()
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
if(AZAHAR_TEAKRA_JIT)
    link_dsp_jit(test_verifier)
    link_dsp_jit(teakra_reference_fixtures)
    target_link_options(teakra_reference_fixtures PRIVATE -sENVIRONMENT=web,worker,node)
    set(DSP_WEB_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
    file(GENERATE OUTPUT "${DSP_WEB_DIRECTORY}/browser-jit.html" INPUT
        "${CMAKE_CURRENT_SOURCE_DIR}/browser-jit.html")
    add_custom_command(OUTPUT "${DSP_WEB_DIRECTORY}/browser-jit.js" "${DSP_WEB_DIRECTORY}/browser-worker.js"
        COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/browser-jit.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/browser-worker.ts" --target browser --outdir "${DSP_WEB_DIRECTORY}"
        DEPENDS browser-jit.ts browser-worker.ts "${AZAHAR_ROOT}/src/web/arm/jit-host.ts"
            "${AZAHAR_ROOT}/src/web/arm/lower.ts" "${AZAHAR_ROOT}/src/web/arm/ir.ts"
            "${AZAHAR_ROOT}/src/web/pica/jit-host.ts" "${AZAHAR_ROOT}/src/web/pica/lower.ts"
            "${AZAHAR_ROOT}/src/web/pica/control-flow.ts" "${AZAHAR_ROOT}/src/web/pica/instruction.ts"
            "${AZAHAR_ROOT}/src/web/wasm/binary.ts" "${AZAHAR_ROOT}/src/web/protocol.ts"
        VERBATIM)
    add_custom_target(browser_dsp_fixtures DEPENDS teakra_reference_fixtures azahar_dsp_jit_host
        "${DSP_WEB_DIRECTORY}/browser-jit.js" "${DSP_WEB_DIRECTORY}/browser-worker.js")
    add_test(NAME teakra_reference_fixtures COMMAND "${NODE_EXECUTABLE}"
        "${DSP_JIT_RUNNER}" "$<TARGET_FILE:teakra_reference_fixtures>")
else()
    register_fixture(teakra_reference_fixtures)
endif()
add_custom_target(upstream_fixtures DEPENDS azahar_portable_fixtures dynarmic_fp_fixtures
    teakra_reference_fixtures test_verifier)
include(cubeb-resampler.cmake)

if(EMSCRIPTEN)
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    set(ARM_JIT_RUNNER "${CMAKE_CURRENT_BINARY_DIR}/run-jit.mjs")
    add_custom_command(OUTPUT "${ARM_JIT_RUNNER}"
        COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/run-jit.ts"
            --target node --outfile "${ARM_JIT_RUNNER}"
        DEPENDS run-jit.ts "${AZAHAR_ROOT}/src/web/arm/jit-host.ts"
            "${AZAHAR_ROOT}/src/web/arm/lower.ts" "${AZAHAR_ROOT}/src/web/arm/ir.ts"
            "${AZAHAR_ROOT}/src/web/pica/jit-host.ts" "${AZAHAR_ROOT}/src/web/pica/lower.ts"
            "${AZAHAR_ROOT}/src/web/pica/control-flow.ts" "${AZAHAR_ROOT}/src/web/pica/instruction.ts"
            "${AZAHAR_ROOT}/src/web/wasm/binary.ts" "${AZAHAR_ROOT}/src/web/protocol.ts"
        VERBATIM)
    add_custom_target(arm_jit_fixture_runner DEPENDS "${ARM_JIT_RUNNER}")
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
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_arm_jit_fixtures PROPERTIES SUFFIX ".mjs")
    add_dependencies(dynarmic_arm_jit_fixtures arm_jit_fixture_runner)
    add_test(NAME dynarmic_arm_jit_fixtures COMMAND "${NODE_EXECUTABLE}"
        "${ARM_JIT_RUNNER}" "$<TARGET_FILE:dynarmic_arm_jit_fixtures>")
    add_test(NAME dynarmic_arm_region_fixtures COMMAND "${NODE_EXECUTABLE}"
        "${ARM_JIT_RUNNER}" "$<TARGET_FILE:dynarmic_arm_jit_fixtures>" --arm-region-tier)
    configure_file(browser-jit.html browser-jit.html COPYONLY)
    add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/browser-jit.js"
        "${CMAKE_CURRENT_BINARY_DIR}/browser-worker.js"
        COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/browser-jit.ts"
            "${CMAKE_CURRENT_SOURCE_DIR}/browser-worker.ts"
            --target browser --outdir "${CMAKE_CURRENT_BINARY_DIR}"
        DEPENDS browser-jit.ts browser-worker.ts "${AZAHAR_ROOT}/src/web/arm/jit-host.ts"
            "${AZAHAR_ROOT}/src/web/arm/lower.ts" "${AZAHAR_ROOT}/src/web/arm/ir.ts"
            "${AZAHAR_ROOT}/src/web/pica/jit-host.ts" "${AZAHAR_ROOT}/src/web/pica/lower.ts"
            "${AZAHAR_ROOT}/src/web/pica/control-flow.ts" "${AZAHAR_ROOT}/src/web/pica/instruction.ts"
            "${AZAHAR_ROOT}/src/web/wasm/binary.ts" "${AZAHAR_ROOT}/src/web/protocol.ts")
    add_custom_target(browser_jit_fixtures DEPENDS
        dynarmic_arm_jit_fixtures "${CMAKE_CURRENT_BINARY_DIR}/browser-jit.js"
        "${CMAKE_CURRENT_BINARY_DIR}/browser-worker.js")
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
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=536870912)
    set_target_properties(dynarmic_vfp_recordings PROPERTIES SUFFIX ".mjs")
    add_dependencies(dynarmic_vfp_recordings arm_jit_fixture_runner)
    add_test(NAME dynarmic_vfp_recordings COMMAND "${NODE_EXECUTABLE}"
        "${ARM_JIT_RUNNER}" "$<TARGET_FILE:dynarmic_vfp_recordings>")
    add_test(NAME dynarmic_vfp_region_recordings COMMAND "${NODE_EXECUTABLE}"
        "${ARM_JIT_RUNNER}" "$<TARGET_FILE:dynarmic_vfp_recordings>" --arm-region-tier)
else()
    target_link_libraries(dynarmic_vfp_recordings PRIVATE dynarmic merry::mcl fmt::fmt)
    register_fixture(dynarmic_vfp_recordings)
endif()
add_dependencies(upstream_fixtures dynarmic_vfp_recordings)

option(AZAHAR_BUILD_UPSTREAM_FUZZ "Build Dynarmic's native Unicorn comparison fixtures" OFF)
if(AZAHAR_BUILD_UPSTREAM_FUZZ)
    include(fuzz.cmake)
endif()
