add_executable(tests
    common/bit_field.cpp
    common/file_util.cpp
    common/param_package.cpp
    core/core_timing.cpp
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
    # The native interpreter is an oracle for the original shader cases, never a core backend.
    target_sources(tests PRIVATE "${PROJECT_SOURCE_DIR}/src/video_core/shader/shader_interpreter.cpp")
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    set_target_properties(tests PROPERTIES SUFFIX ".mjs")
    target_compile_definitions(tests PRIVATE CATCH_CONFIG_NO_POSIX_SIGNALS)
    target_link_options(tests PRIVATE
        -sWASMFS=1
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
    add_test(NAME tests COMMAND "${BUN_EXECUTABLE}"
        "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-jit.ts" "$<TARGET_FILE:tests>")
    add_test(NAME pica_control_flow COMMAND "${BUN_EXECUTABLE}"
        "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-jit.ts" "$<TARGET_FILE:tests>"
        "[shader]" --pica-dispatch)
    set(TEST_WEB_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>")
    file(GENERATE OUTPUT "${TEST_WEB_DIRECTORY}/browser-jit.html"
        INPUT "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.html")
    add_custom_command(OUTPUT "${TEST_WEB_DIRECTORY}/browser-jit.js"
        "${TEST_WEB_DIRECTORY}/browser-worker.js"
        COMMAND "${BUN_EXECUTABLE}" build "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.ts"
            "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-worker.ts"
            --target browser --outdir "${TEST_WEB_DIRECTORY}"
        DEPENDS "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-jit.ts"
            "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/browser-worker.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/jit-host.ts" "${PROJECT_SOURCE_DIR}/src/web/arm/lower.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/ir.ts" "${PROJECT_SOURCE_DIR}/src/web/wasm/binary.ts"
            "${PROJECT_SOURCE_DIR}/src/web/pica/jit-host.ts" "${PROJECT_SOURCE_DIR}/src/web/pica/lower.ts"
            "${PROJECT_SOURCE_DIR}/src/web/pica/control-flow.ts" "${PROJECT_SOURCE_DIR}/src/web/pica/instruction.ts"
            "${PROJECT_SOURCE_DIR}/src/web/protocol.ts")
    add_custom_target(browser_core_fixtures DEPENDS tests "${TEST_WEB_DIRECTORY}/browser-jit.js"
        "${TEST_WEB_DIRECTORY}/browser-worker.js")

    # Compile the SDK's original OPFS cases, including its cross-session persistence checks.
    foreach(mode IN ITEMS setup resume)
        add_executable(wasmfs_opfs_${mode} "${PROJECT_SOURCE_DIR}/externals/emscripten/test/wasmfs/wasmfs_opfs.c")
        target_link_libraries(wasmfs_opfs_${mode} PRIVATE emscripten_opfs)
        string(TOUPPER "${mode}" mode_define)
        target_compile_definitions(wasmfs_opfs_${mode} PRIVATE WASMFS_${mode_define})
        target_compile_options(wasmfs_opfs_${mode} PRIVATE -UNDEBUG)
        target_link_options(wasmfs_opfs_${mode} PRIVATE
            -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker
            -sPTHREAD_POOL_SIZE=1 -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
        set_target_properties(wasmfs_opfs_${mode} PROPERTIES SUFFIX ".mjs")
    endforeach()
    add_custom_target(browser_storage_fixtures DEPENDS wasmfs_opfs_setup wasmfs_opfs_resume
        "${TEST_WEB_DIRECTORY}/browser-jit.js" "${TEST_WEB_DIRECTORY}/browser-worker.js")
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
