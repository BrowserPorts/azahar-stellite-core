cmake_minimum_required(VERSION 3.25)
project(azahar_wasm_frontend LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(AZAHAR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
set(DYNARMIC_ROOT "${AZAHAR_ROOT}/externals/dynarmic")
set(FMT_INSTALL OFF CACHE BOOL "" FORCE)
set(MCL_INSTALL OFF CACHE BOOL "" FORCE)
set(MCL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(MCL_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
if(NOT TARGET fmt::fmt)
    add_subdirectory("${AZAHAR_ROOT}/externals/fmt" "${CMAKE_CURRENT_BINARY_DIR}/fmt" EXCLUDE_FROM_ALL)
endif()
if(NOT TARGET merry::mcl)
    add_subdirectory("${DYNARMIC_ROOT}/externals/mcl" "${CMAKE_CURRENT_BINARY_DIR}/mcl" EXCLUDE_FROM_ALL)
endif()

# The compiler includes portable A32 translation and IR, without native backends.
file(GLOB_RECURSE A32_TRANSLATION CONFIGURE_DEPENDS
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/translate/*.cpp")
file(GLOB IR_SOURCES CONFIGURE_DEPENDS "${DYNARMIC_ROOT}/src/dynarmic/ir/*.cpp")
if(EMSCRIPTEN)
    # Dynarmic's native host-call encoding assumes 64-bit function pointers.
    # A build-local copy keeps the pinned submodule untouched on wasm32.
    set(IR_EMITTER "${DYNARMIC_ROOT}/src/dynarmic/ir/ir_emitter.cpp")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${IR_EMITTER}")
    file(READ "${IR_EMITTER}" IR_EMITTER_TEXT)
    string(REGEX MATCHALL "mcl::bit_cast<u64>\\(fn\\)" HOST_CALL_CASTS "${IR_EMITTER_TEXT}")
    list(LENGTH HOST_CALL_CASTS HOST_CALL_COUNT)
    if(NOT HOST_CALL_COUNT EQUAL 4)
        message(FATAL_ERROR "The pinned Dynarmic host-call implementation changed")
    endif()
    string(REPLACE "mcl::bit_cast<u64>(fn)" "static_cast<u64>(reinterpret_cast<uintptr_t>(fn))"
        IR_EMITTER_TEXT "${IR_EMITTER_TEXT}")
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/wasm_ir_emitter.cpp" "${IR_EMITTER_TEXT}")
    list(REMOVE_ITEM IR_SOURCES "${IR_EMITTER}")
    list(APPEND IR_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/wasm_ir_emitter.cpp")
endif()
add_library(azahar_arm_frontend STATIC
    ir_json.cpp
    ${A32_TRANSLATION}
    ${IR_SOURCES}
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/a32_types.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/a32_ir_emitter.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/A32/a32_location_descriptor.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/A64/a64_types.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/frontend/imm.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/memory_pool.cpp"
    "${DYNARMIC_ROOT}/src/dynarmic/common/u128.cpp")
target_include_directories(azahar_arm_frontend PUBLIC
    "${DYNARMIC_ROOT}/src" "${AZAHAR_ROOT}/externals/boost" "${AZAHAR_ROOT}/src")
target_link_libraries(azahar_arm_frontend PUBLIC fmt::fmt merry::mcl)
target_compile_options(azahar_arm_frontend PRIVATE -Wall -Wextra)
add_executable(azahar_wasm_frontend frontend.cpp
    "${AZAHAR_ROOT}/src/core/arm/dynarmic/arm_tick_counts.cpp")
target_link_libraries(azahar_wasm_frontend PRIVATE azahar_arm_frontend)
if(EMSCRIPTEN)
    target_compile_options(azahar_arm_frontend PRIVATE -O3 -fwasm-exceptions)
    target_compile_options(azahar_wasm_frontend PRIVATE -O3 -fwasm-exceptions)
    target_link_options(azahar_wasm_frontend PRIVATE
        -O3 -fwasm-exceptions --no-entry
        "-sEXPORTED_FUNCTIONS=['_malloc','_free','_azahar_translate','_azahar_result_size']"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','UTF8ToString']"
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker,node
        -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=536870912
        -sSTACK_SIZE=4194304 -sDYNAMIC_EXECUTION=0)
    set_target_properties(azahar_wasm_frontend PROPERTIES SUFFIX ".js")
endif()
