# SPDX-License-Identifier: GPL-2.0-or-later

set(GLSLANG_SOURCE_DIR "${PROJECT_SOURCE_DIR}/externals/glslang")
set(GLSLANG_TESTS OFF)
set(GLSLANG_ENABLE_INSTALL OFF)
set(ENABLE_GLSLANG_BINARIES OFF)
set(ENABLE_GLSLANG_JS OFF)
set(ENABLE_SPVREMAPPER OFF)
set(ENABLE_HLSL ${ENABLE_TESTS})
set(ENABLE_OPT ON)
set(BUILD_EXTERNAL OFF)
if(NOT TARGET SPIRV-Tools-opt)
    set(SPIRV-Headers_SOURCE_DIR "${PROJECT_SOURCE_DIR}/externals/spirv-headers")
    set(SPIRV_SKIP_EXECUTABLES ON)
    add_subdirectory("${PROJECT_SOURCE_DIR}/externals/spirv-tools" spirv-tools EXCLUDE_FROM_ALL)
endif()
add_subdirectory("${GLSLANG_SOURCE_DIR}" upstream EXCLUDE_FROM_ALL)

# Reuse the upstream Web entry points with the current Emscripten module format.
add_executable(azahar_glslang "${GLSLANG_SOURCE_DIR}/glslang/OSDependent/Web/glslang.js.cpp")
target_link_libraries(azahar_glslang PRIVATE glslang)
set_target_properties(azahar_glslang PROPERTIES
    OUTPUT_NAME "azahar-glslang" SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
target_link_options(azahar_glslang PRIVATE
    --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAzaharGlslang
    -sENVIRONMENT=web,worker,node -sDYNAMIC_EXECUTION=0
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304 -sEXIT_RUNTIME=0
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','stringToNewUTF8']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_convert_glsl_to_spirv','_destroy_output_buffer']")

if(ENABLE_TESTS)
    include(FetchContent)
    # This is glslang's known_good.json GoogleTest v1.14.0 revision.
    set(INSTALL_GTEST OFF)
    FetchContent_Declare(googletest
        URL https://codeload.github.com/google/googletest/tar.gz/f8d7d77c06936315286eb55f8de22cd23c188571
        URL_HASH SHA256=7ff5db23de232a39cbb5c9f5143c355885e30ac596161a6b9fc50c4538bfbf01
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(googletest)

    # Add the original GoogleTest suite independently of the native bash runner.
    set(GLSLANG_TESTS ON)
    add_subdirectory("${GLSLANG_SOURCE_DIR}/gtests" fixtures EXCLUDE_FROM_ALL)
    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    target_compile_definitions(glslangtests PRIVATE ENABLE_HLSL ENABLE_OPT=1 ENABLE_SPIRV)
    set_target_properties(glslangtests PROPERTIES
        SUFFIX ".cjs" CROSSCOMPILING_EMULATOR "${NODE_EXECUTABLE}")
    target_link_options(glslangtests PRIVATE
        -sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1
        -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304 -sDYNAMIC_EXECUTION=0)
endif()
