set(CORE_TIMING_FIXTURE core/core_timing.cpp)
if(EMSCRIPTEN)
    # Keep the native fixture's 64-bit event payloads when adapting its callback signatures.
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/core/core_timing.cpp")
    file(READ "${CMAKE_CURRENT_SOURCE_DIR}/core/core_timing.cpp" CORE_TIMING_SOURCE)
    string(REGEX MATCHALL "std::uintptr_t user_data" CORE_TIMING_PARAMETERS "${CORE_TIMING_SOURCE}")
    list(LENGTH CORE_TIMING_PARAMETERS CORE_TIMING_PARAMETER_COUNT)
    if(NOT CORE_TIMING_PARAMETER_COUNT EQUAL 4)
        message(FATAL_ERROR "The native timing fixture callback signatures changed")
    endif()
    string(REPLACE "std::uintptr_t user_data" "u64 user_data" CORE_TIMING_SOURCE "${CORE_TIMING_SOURCE}")
    set(CORE_TIMING_FIXTURE "${CMAKE_CURRENT_BINARY_DIR}/core_timing_wasm.cpp")
    file(WRITE "${CORE_TIMING_FIXTURE}" "${CORE_TIMING_SOURCE}")
endif()

add_executable(tests
    common/bit_field.cpp
    common/file_util.cpp
    common/param_package.cpp
    ${CORE_TIMING_FIXTURE}
    core/file_sys/path_parser.cpp
    core/hle/kernel/hle_ipc.cpp
    core/memory/memory.cpp
    core/memory/vm_manager.cpp
    precompiled_headers.h
    audio_core/hle/hle.cpp
    audio_core/hle/source.cpp
    audio_core/lle/lle.cpp
    audio_core/audio_fixures.h
    audio_core/decoder_tests.cpp
    video_core/pica_types.cpp
    video_core/shader.cpp
    audio_core/merryhime_3ds_audio/merry_audio/merry_audio.cpp
    audio_core/merryhime_3ds_audio/merry_audio/merry_audio.h
    audio_core/merryhime_3ds_audio/merry_audio/service_fixture.cpp
    audio_core/merryhime_3ds_audio/merry_audio/service_fixture.h
    audio_core/merryhime_3ds_audio/audio_test_biquad_filter.cpp
)

create_target_directory_groups(tests)

if (BSD STREQUAL "NetBSD")
    include(DisablePaxMprotect)
    disable_pax_mprotect(tests)
endif()

target_link_libraries(tests PRIVATE citra_common citra_core video_core audio_core)
target_link_libraries(tests PRIVATE ${PLATFORM_LIBRARIES} catch2 nihstro-headers Threads::Threads)

if (ENABLE_LIBRETRO)
    target_link_libraries(tests PRIVATE $<TARGET_OBJECTS:citra_libretro_common>)
endif()

if(EMSCRIPTEN)
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    set_target_properties(tests PROPERTIES SUFFIX ".mjs")
    target_compile_definitions(tests PRIVATE CATCH_CONFIG_NO_POSIX_SIGNALS)
    target_link_options(tests PRIVATE
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
    add_test(NAME tests COMMAND "${BUN_EXECUTABLE}"
        "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-jit.ts" "$<TARGET_FILE:tests>")
    set(TEST_WEB_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
    file(GENERATE OUTPUT "${TEST_WEB_DIRECTORY}/browser-jit.html"
        INPUT "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.html")
    add_custom_command(OUTPUT "${TEST_WEB_DIRECTORY}/browser-jit.js"
        COMMAND "${BUN_EXECUTABLE}" build "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.ts"
            --target browser --outfile "${TEST_WEB_DIRECTORY}/browser-jit.js"
        DEPENDS "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/jit-host.ts" "${PROJECT_SOURCE_DIR}/src/web/arm/lower.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/ir.ts" "${PROJECT_SOURCE_DIR}/src/web/wasm/binary.ts"
            "${PROJECT_SOURCE_DIR}/src/web/protocol.ts")
    add_custom_target(browser_core_fixtures DEPENDS tests "${TEST_WEB_DIRECTORY}/browser-jit.js")
else()
    add_test(NAME tests COMMAND tests)
endif()
if(NOT ANDROID AND (CMAKE_SYSTEM_NAME STREQUAL CMAKE_HOST_SYSTEM_NAME))
    catch_discover_tests(tests)
endif()


if (CITRA_USE_PRECOMPILED_HEADERS)
    target_precompile_headers(tests PRIVATE precompiled_headers.h)
endif()

# Bundle in-place on MSVC so dependencies can be resolved by builds.
if (MSVC)
    include(BundleTarget)
    bundle_target_in_place(tests)
endif()
