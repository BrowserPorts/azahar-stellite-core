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
    azahar_enable_dsp_runtime(tests)
    # The native interpreter is an oracle for the original shader cases, never a core backend.
    target_sources(tests PRIVATE "${PROJECT_SOURCE_DIR}/src/video_core/shader/shader_interpreter.cpp")
    find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    set(CORE_JIT_RUNNER "${CMAKE_CURRENT_BINARY_DIR}/run-jit.mjs")
    add_custom_command(OUTPUT "${CORE_JIT_RUNNER}"
        COMMAND "${BUN_EXECUTABLE}" build "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-jit.ts"
            --target node --outfile "${CORE_JIT_RUNNER}"
        DEPENDS "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-jit.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/jit-host.ts" "${PROJECT_SOURCE_DIR}/src/web/arm/lower.ts"
            "${PROJECT_SOURCE_DIR}/src/web/arm/ir.ts" "${PROJECT_SOURCE_DIR}/src/web/wasm/binary.ts"
            "${PROJECT_SOURCE_DIR}/src/web/pica/jit-host.ts" "${PROJECT_SOURCE_DIR}/src/web/pica/lower.ts"
            "${PROJECT_SOURCE_DIR}/src/web/pica/control-flow.ts" "${PROJECT_SOURCE_DIR}/src/web/pica/instruction.ts"
            "${PROJECT_SOURCE_DIR}/src/web/protocol.ts"
        VERBATIM)
    add_custom_target(core_jit_fixture_runner DEPENDS "${CORE_JIT_RUNNER}")
    add_dependencies(tests core_jit_fixture_runner)
    set_target_properties(tests PROPERTIES SUFFIX ".mjs")
    target_compile_definitions(tests PRIVATE CATCH_CONFIG_NO_POSIX_SIGNALS)
    target_link_options(tests PRIVATE
        -sWASMFS=1
        -sEXPORTED_RUNTIME_METHODS=FS
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
        -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=4194304 -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
    add_test(NAME tests COMMAND "${NODE_EXECUTABLE}"
        "${CORE_JIT_RUNNER}" "$<TARGET_FILE:tests>")
    add_test(NAME pica_control_flow COMMAND "${NODE_EXECUTABLE}"
        "${CORE_JIT_RUNNER}" "$<TARGET_FILE:tests>"
        "[shader]" --pica-dispatch)
    # Run the original firmware-free sections independently of the LLE sections.
    add_test(NAME audio_hle_fixtures COMMAND "${NODE_EXECUTABLE}"
        "${CORE_JIT_RUNNER}" "$<TARGET_FILE:tests>"
        "Verify SourceStatus::Status::last_buffer_id*,AudioTest-BiquadFilter"
        --section HLE)
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

    # Retain the SDK's original JSPI export and indirect-function assertions.
    foreach(jspi_case IN ITEMS wildcard add_function)
        add_executable(wasm_jspi_${jspi_case}
            "${PROJECT_SOURCE_DIR}/externals/emscripten/test/other/test_jspi_${jspi_case}.c")
        target_compile_options(wasm_jspi_${jspi_case} PRIVATE -UNDEBUG)
        target_link_options(wasm_jspi_${jspi_case} PRIVATE
            -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
            -sJSPI=1 -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=1 -sEXIT_RUNTIME=1
            -sDYNAMIC_EXECUTION=0)
        if(jspi_case STREQUAL "wildcard")
            target_link_options(wasm_jspi_${jspi_case} PRIVATE "-sJSPI_EXPORTS=async*")
        else()
            target_link_options(wasm_jspi_${jspi_case} PRIVATE
                -sEXPORTED_RUNTIME_METHODS=addFunction,dynCall -sALLOW_TABLE_GROWTH=1)
        endif()
        set_target_properties(wasm_jspi_${jspi_case} PROPERTIES SUFFIX ".mjs")
        add_dependencies(wasm_jspi_${jspi_case} core_jit_fixture_runner)
        add_test(NAME wasm_jspi_${jspi_case} COMMAND "${NODE_EXECUTABLE}"
            "${CORE_JIT_RUNNER}" "$<TARGET_FILE:wasm_jspi_${jspi_case}>")
    endforeach()
    add_custom_target(browser_jspi_fixtures DEPENDS wasm_jspi_wildcard wasm_jspi_add_function
        "${TEST_WEB_DIRECTORY}/browser-jit.js" "${TEST_WEB_DIRECTORY}/browser-worker.js")

    # Compile the SDK's original OPFS cases, including its cross-session persistence checks.
    foreach(mode IN ITEMS setup resume errors unlink)
        set(opfs_source "${PROJECT_SOURCE_DIR}/externals/emscripten/test/wasmfs/wasmfs_opfs.c")
        if(mode STREQUAL "errors")
            set(opfs_source "${PROJECT_SOURCE_DIR}/externals/emscripten/test/wasmfs/wasmfs_opfs_errors.c")
        elseif(mode STREQUAL "unlink")
            set(opfs_source "${PROJECT_SOURCE_DIR}/externals/emscripten/test/other/test_unlink.cpp")
        endif()
        add_executable(wasmfs_opfs_${mode} "${opfs_source}")
        target_link_libraries(wasmfs_opfs_${mode} PRIVATE emscripten_opfs)
        if(mode STREQUAL "errors")
            # The runner already executes main in a dedicated worker. Report the original
            # asynchronous result through its exit callback instead of the SDK test server.
            target_compile_definitions(wasmfs_opfs_${mode} PRIVATE REPORT_RESULT=emscripten_force_exit)
            set(opfs_post_js "${PROJECT_SOURCE_DIR}/externals/emscripten/test/wasmfs/wasmfs_opfs_errors_post.js")
            target_link_options(wasmfs_opfs_${mode} PRIVATE "SHELL:--post-js \"${opfs_post_js}\"")
            set_property(TARGET wasmfs_opfs_${mode} APPEND PROPERTY LINK_DEPENDS "${opfs_post_js}")
        elseif(mode STREQUAL "unlink")
            target_sources(wasmfs_opfs_${mode} PRIVATE
                "${PROJECT_SOURCE_DIR}/src/web/tests/upstream/opfs-main.cpp")
            target_compile_definitions(wasmfs_opfs_${mode} PRIVATE main=upstream_main WASMFS)
        else()
            string(TOUPPER "${mode}" mode_define)
            target_compile_definitions(wasmfs_opfs_${mode} PRIVATE WASMFS_${mode_define})
        endif()
        target_compile_options(wasmfs_opfs_${mode} PRIVATE -UNDEBUG)
        target_link_options(wasmfs_opfs_${mode} PRIVATE
            -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker
            -sPTHREAD_POOL_SIZE=1 -sJSPI=1 -sEXIT_RUNTIME=1 -sDYNAMIC_EXECUTION=0)
        set_target_properties(wasmfs_opfs_${mode} PROPERTIES SUFFIX ".mjs")
    endforeach()
    add_custom_target(browser_storage_fixtures DEPENDS wasmfs_opfs_setup wasmfs_opfs_resume wasmfs_opfs_errors wasmfs_opfs_unlink
        "${TEST_WEB_DIRECTORY}/browser-jit.js" "${TEST_WEB_DIRECTORY}/browser-worker.js")

    # Build the SDK's original browser audio cases with their native inputs and assertions.
    set(AUDIO_WEB_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/audio-fixtures")
    foreach(audio_case IN ITEMS audio_context_sample_rate audioworklet audioworklet_in_out_stereo audioworklet_in_out_mono)
        add_executable(wasm_audio_${audio_case}
            "${PROJECT_SOURCE_DIR}/externals/emscripten/test/webaudio/${audio_case}.c")
        target_compile_options(wasm_audio_${audio_case} PRIVATE -UNDEBUG)
        target_link_options(wasm_audio_${audio_case} PRIVATE
            -sENVIRONMENT=web -sEXIT_RUNTIME=1 -sASSERTIONS=1 -sINVOKE_RUN=0
            "-sEXPORTED_RUNTIME_METHODS=['callMain']")
        if(NOT audio_case STREQUAL "audio_context_sample_rate")
            target_compile_definitions(wasm_audio_${audio_case} PRIVATE TEST_AND_EXIT)
            target_link_options(wasm_audio_${audio_case} PRIVATE -sAUDIO_WORKLET=1 -sWASM_WORKERS=1)
        else()
            target_link_options(wasm_audio_${audio_case} PRIVATE -lwebaudio.js)
        endif()
        set_target_properties(wasm_audio_${audio_case} PROPERTIES SUFFIX ".html"
            RUNTIME_OUTPUT_DIRECTORY "${AUDIO_WEB_DIRECTORY}")
    endforeach()
    set(AUDIO_WEB_ASSETS)
    foreach(audio_file IN ITEMS emscripten-beat.mp3 emscripten-bass.mp3
        emscripten-beat-mono.mp3 emscripten-bass-mono.mp3)
        set(audio_asset "${AUDIO_WEB_DIRECTORY}/audio_files/${audio_file}")
        set(audio_input "${PROJECT_SOURCE_DIR}/externals/emscripten/test/webaudio/audio_files/${audio_file}")
        add_custom_command(OUTPUT "${audio_asset}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${AUDIO_WEB_DIRECTORY}/audio_files"
            COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${audio_input}" "${audio_asset}"
            DEPENDS "${audio_input}" VERBATIM)
        list(APPEND AUDIO_WEB_ASSETS "${audio_asset}")
    endforeach()
    add_custom_target(browser_audio_fixtures DEPENDS
        wasm_audio_audio_context_sample_rate wasm_audio_audioworklet wasm_audio_audioworklet_in_out_stereo
        wasm_audio_audioworklet_in_out_mono ${AUDIO_WEB_ASSETS})

    # Preserve the SDK's original motion/event registration and listener lifetime cases.
    foreach(input_case IN ITEMS html5_core html5_remove_event_listener)
        add_executable(wasm_input_${input_case}
            "${PROJECT_SOURCE_DIR}/externals/emscripten/test/browser/test_${input_case}.c")
        target_compile_options(wasm_input_${input_case} PRIVATE -UNDEBUG)
        target_link_options(wasm_input_${input_case} PRIVATE
            -sENVIRONMENT=web -sEXIT_RUNTIME=1 -sASSERTIONS=1 -sINVOKE_RUN=0
            "-sEXPORTED_RUNTIME_METHODS=['callMain']")
        set_target_properties(wasm_input_${input_case} PROPERTIES SUFFIX ".html"
            RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/input-fixtures")
    endforeach()
    add_custom_target(browser_input_fixtures DEPENDS
        wasm_input_html5_core wasm_input_html5_remove_event_listener)
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
