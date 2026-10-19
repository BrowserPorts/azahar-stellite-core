# SPDX-License-Identifier: GPL-2.0-or-later

add_executable(azahar_browser entry.cpp file-system.cpp)
azahar_enable_dsp_runtime(azahar_browser)
target_link_libraries(azahar_browser PRIVATE citra_libretro libretro Boost::boost fmt::fmt cryptopp emscripten_opfs json-headers)
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
    # Native startup needs resident WasmFS, logging, async-job and DSP workers.
    -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=2 -sEXIT_RUNTIME=0
    "-sJSPI_EXPORTS=['azahar_initialize','azahar_load_game','azahar_install_cia','azahar_run_frame','azahar_reset_game','azahar_flush_saves','azahar_shutdown','retro_serialize_size','retro_serialize','retro_unserialize']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','HEAP16','UTF8ToString','stringToNewUTF8','addFunction','removeFunction']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_retro_init','_retro_deinit','_retro_api_version','_retro_get_system_info','_retro_get_system_av_info','_retro_set_environment','_retro_set_video_refresh','_retro_set_audio_sample','_retro_set_audio_sample_batch','_retro_set_input_poll','_retro_set_input_state','_retro_set_controller_port_device','_retro_reset','_retro_run','_retro_load_game','_retro_unload_game','_retro_serialize_size','_retro_serialize','_retro_unserialize','_retro_get_memory_data','_retro_get_memory_size','_retro_get_region']")

# Bundle inputs are listed below. Native assets belong to the aggregate runtime target.
set(CMAKE_ADD_CUSTOM_COMMAND_DEPENDS_EXPLICIT_ONLY ON)
find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
set(WORKER_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-worker.js")
set(CLIENT_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar.js")
set(MICROPHONE_WORKLET_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-microphone-worklet.js")
set(AUDIO_WORKLET_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-audio-worklet.js")
file(GLOB RUNTIME_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.ts")
add_custom_command(OUTPUT "${WORKER_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/worker.ts"
        --target browser --outfile "${WORKER_OUTPUT}"
    DEPENDS ${RUNTIME_SOURCES} ../gpu/client.ts ../gpu/messages.ts ../gpu/draw-types.ts
        ../arm/jit-host.ts ../arm/lower.ts ../arm/ir.ts
        ../pica/jit-host.ts ../pica/lower.ts ../pica/control-flow.ts ../pica/instruction.ts
        ../wasm/binary.ts ../protocol.ts ../assets.ts
    VERBATIM)
add_custom_command(OUTPUT "${CLIENT_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/client.ts"
        --target browser --outfile "${CLIENT_OUTPUT}"
    DEPENDS client.ts messages.ts session.ts audio-output.ts audio-ring.ts motion-input.ts browser-input.ts
        input-state.ts microphone-input.ts microphone-ring.ts ../assets.ts
    VERBATIM)
add_custom_command(OUTPUT "${AUDIO_WORKLET_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/audio-worklet.ts"
        --target browser --outfile "${AUDIO_WORKLET_OUTPUT}"
    DEPENDS audio-worklet.ts audio-ring.ts
    VERBATIM)
add_custom_command(OUTPUT "${MICROPHONE_WORKLET_OUTPUT}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/microphone-worklet.ts"
        --target browser --outfile "${MICROPHONE_WORKLET_OUTPUT}"
    DEPENDS microphone-worklet.ts microphone-ring.ts
    VERBATIM)
add_custom_target(azahar_browser_runtime DEPENDS azahar_browser azahar_graphics_runtime azahar_dsp_templates
    "${WORKER_OUTPUT}" "${CLIENT_OUTPUT}" "${AUDIO_WORKLET_OUTPUT}" "${MICROPHONE_WORKLET_OUTPUT}")

# Install only production runtime assets, independently of frontend and fixture output.
set(WEB_RUNTIME_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
set(WEB_RUNTIME_FILES
    azahar.js
    azahar-worker.js
    azahar-core.mjs
    azahar-core.wasm
    azahar-gpu-worker.js
    azahar-glslang.mjs
    azahar-glslang.wasm
    azahar-shader-compiler.wasm
    azahar-pica-shaders.mjs
    azahar-pica-shaders.wasm
    azahar-dsp-templates.wasm
    azahar-dsp-families.bin
    azahar-dsp-jit.js
    azahar-audio-worklet.js
    azahar-microphone-worklet.js)
list(TRANSFORM WEB_RUNTIME_FILES PREPEND "${WEB_RUNTIME_DIRECTORY}/")
install(FILES ${WEB_RUNTIME_FILES} "${PROJECT_SOURCE_DIR}/license.txt"
    DESTINATION . COMPONENT azahar_web_runtime)
install(FILES "${WEB_RUNTIME_DIRECTORY}/libretro_emscripten.a" "${PROJECT_SOURCE_DIR}/license.txt"
    DESTINATION . COMPONENT azahar_libretro)

set(WEB_PACKAGE_DIRECTORY "${CMAKE_BINARY_DIR}/package/$<CONFIG>")
set(WEB_PACKAGE_ROOT "${WEB_PACKAGE_DIRECTORY}/azahar-web-runtime")
set(WEB_PACKAGE_ARCHIVE "${WEB_PACKAGE_DIRECTORY}/azahar-web-runtime.tar.gz")
add_custom_target(azahar_browser_package
    COMMAND "${CMAKE_COMMAND}" -E rm -rf "${WEB_PACKAGE_ROOT}"
    COMMAND "${CMAKE_COMMAND}" --install "${CMAKE_BINARY_DIR}" --config "$<CONFIG>"
        --component azahar_web_runtime --prefix "${WEB_PACKAGE_ROOT}"
    COMMAND "${CMAKE_COMMAND}" -E chdir "${WEB_PACKAGE_DIRECTORY}"
        "${CMAKE_COMMAND}" -E tar cfz "${WEB_PACKAGE_ARCHIVE}" --format=gnutar -- azahar-web-runtime
    BYPRODUCTS "${WEB_PACKAGE_ARCHIVE}"
    DEPENDS azahar_browser_runtime
    VERBATIM)
