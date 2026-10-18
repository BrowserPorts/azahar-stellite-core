# SPDX-License-Identifier: GPL-2.0-or-later

add_subdirectory(compiler)

add_executable(azahar_pica_shader_generator native-shaders.cpp)
target_link_libraries(azahar_pica_shader_generator PRIVATE video_core)
set_target_properties(azahar_pica_shader_generator PROPERTIES
    OUTPUT_NAME "azahar-pica-shaders" SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
target_link_options(azahar_pica_shader_generator PRIVATE
    --no-entry --emit-symbol-map -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAzaharPicaShaders
    -sENVIRONMENT=web,worker,node -sDYNAMIC_EXECUTION=0
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4194304 -sEXIT_RUNTIME=0
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','UTF8ToString']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free']")

find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
set(GPU_WORKER_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-gpu-worker.js")
file(GLOB GPU_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.ts")
add_custom_command(OUTPUT "${GPU_WORKER_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/worker.ts"
        --target browser --outfile "${GPU_WORKER_OUTPUT}"
    DEPENDS ${GPU_SOURCES}
    VERBATIM)
add_custom_target(azahar_graphics_runtime DEPENDS azahar_shader_compiler azahar_glslang
    azahar_pica_shader_generator "${GPU_WORKER_OUTPUT}")
