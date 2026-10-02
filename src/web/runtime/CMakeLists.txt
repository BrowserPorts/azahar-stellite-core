# SPDX-License-Identifier: GPL-2.0-or-later

add_executable(azahar_browser entry.cpp)
target_link_libraries(azahar_browser PRIVATE citra_libretro libretro Boost::boost fmt::fmt)
target_include_directories(azahar_browser PRIVATE "${PROJECT_BINARY_DIR}/src")
set_target_properties(azahar_browser PROPERTIES
    OUTPUT_NAME "azahar-core" SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
target_link_options(azahar_browser PRIVATE
    -lworkerfs.js
    --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAzaharCore
    -sENVIRONMENT=web,worker,node -sDYNAMIC_EXECUTION=0
    -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1
    -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=0
    "-sEXPORTED_RUNTIME_METHODS=['FS','WORKERFS','HEAPU8','HEAPU32','HEAP16','UTF8ToString','stringToNewUTF8','addFunction','removeFunction']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_retro_init','_retro_deinit','_retro_api_version','_retro_get_system_info','_retro_get_system_av_info','_retro_set_environment','_retro_set_video_refresh','_retro_set_audio_sample','_retro_set_audio_sample_batch','_retro_set_input_poll','_retro_set_input_state','_retro_set_controller_port_device','_retro_reset','_retro_run','_retro_load_game','_retro_unload_game','_retro_serialize_size','_retro_serialize','_retro_unserialize','_retro_get_memory_data','_retro_get_memory_size','_retro_get_region']")
