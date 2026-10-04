# SPDX-License-Identifier: GPL-2.0-or-later

add_subdirectory(../gpu/compiler "${CMAKE_CURRENT_BINARY_DIR}/shader-compiler")

add_executable(azahar_pica_shader_generator ../gpu/native-shaders.cpp)
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

add_executable(azahar_browser entry.cpp file-system.cpp)
azahar_enable_dsp_runtime(azahar_browser)
target_link_libraries(azahar_browser PRIVATE citra_libretro libretro Boost::boost fmt::fmt cryptopp emscripten_opfs)
target_include_directories(azahar_browser PRIVATE "${PROJECT_BINARY_DIR}/src"
    "${EMSCRIPTEN_ROOT_PATH}/system/lib/wasmfs")
set_property(TARGET azahar_browser APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/file-system.js")
set_target_properties(azahar_browser PROPERTIES
    OUTPUT_NAME "azahar-core" SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
target_link_options(azahar_browser PRIVATE
    "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/file-system.js\""
    --no-entry --emit-symbol-map -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAzaharCore
    -sENVIRONMENT=web,worker,node -sDYNAMIC_EXECUTION=0
    -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1
    -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=0
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','HEAP16','UTF8ToString','stringToNewUTF8','addFunction','removeFunction']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_retro_init','_retro_deinit','_retro_api_version','_retro_get_system_info','_retro_get_system_av_info','_retro_set_environment','_retro_set_video_refresh','_retro_set_audio_sample','_retro_set_audio_sample_batch','_retro_set_input_poll','_retro_set_input_state','_retro_set_controller_port_device','_retro_reset','_retro_run','_retro_load_game','_retro_unload_game','_retro_serialize_size','_retro_serialize','_retro_unserialize','_retro_get_memory_data','_retro_get_memory_size','_retro_get_region']")

find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
set(WORKER_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-worker.js")
set(CLIENT_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar.js")
set(GPU_WORKER_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-gpu-worker.js")
file(GLOB RUNTIME_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.ts")
file(GLOB GPU_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../gpu/*.ts")
add_custom_command(OUTPUT "${WORKER_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/worker.ts"
        --target browser --outfile "${WORKER_OUTPUT}"
    DEPENDS ${RUNTIME_SOURCES} ../gpu/client.ts ../gpu/messages.ts ../gpu/draw-types.ts
        ../arm/jit-host.ts ../arm/lower.ts ../arm/ir.ts
        ../pica/jit-host.ts ../pica/lower.ts ../pica/control-flow.ts ../pica/instruction.ts
        ../wasm/binary.ts ../protocol.ts
    VERBATIM)
add_custom_command(OUTPUT "${GPU_WORKER_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/../gpu/worker.ts"
        --target browser --outfile "${GPU_WORKER_OUTPUT}"
    DEPENDS ${GPU_SOURCES}
    VERBATIM)
add_custom_command(OUTPUT "${CLIENT_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/client.ts"
        --target browser --outfile "${CLIENT_OUTPUT}"
    DEPENDS client.ts messages.ts session.ts
    VERBATIM)
add_custom_target(azahar_browser_runtime DEPENDS azahar_browser azahar_shader_compiler azahar_glslang
    azahar_pica_shader_generator azahar_dsp_templates
    "${WORKER_OUTPUT}" "${GPU_WORKER_OUTPUT}" "${CLIENT_OUTPUT}")
