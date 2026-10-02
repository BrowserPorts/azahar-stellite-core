# SPDX-License-Identifier: GPL-2.0-or-later

find_program(RUSTUP_EXECUTABLE NAMES rustup REQUIRED)
set(AZAHAR_RUST_TOOLCHAIN "1.94.0" CACHE STRING "Rust toolchain for the shader compiler")
execute_process(COMMAND "${RUSTUP_EXECUTABLE}" which --toolchain "${AZAHAR_RUST_TOOLCHAIN}" rustc
    OUTPUT_VARIABLE SHADER_RUSTC OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
set(SHADER_CARGO_COMMAND "${CMAKE_COMMAND}" -E env "RUSTC=${SHADER_RUSTC}"
    "${RUSTUP_EXECUTABLE}" run "${AZAHAR_RUST_TOOLCHAIN}" cargo)
set(SHADER_CARGO_TARGET "${CMAKE_CURRENT_BINARY_DIR}/cargo")
set(SHADER_COMPILER_OUTPUT "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-shader-compiler.wasm")
file(GLOB_RECURSE NAGA_SOURCES CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/externals/wgpu/naga/src/*.rs"
    "${PROJECT_SOURCE_DIR}/externals/wgpu/naga-types/src/*.rs")
add_custom_command(OUTPUT "${SHADER_COMPILER_OUTPUT}"
    COMMAND ${SHADER_CARGO_COMMAND} build
        --manifest-path "${CMAKE_CURRENT_SOURCE_DIR}/Cargo.toml" --locked --release
        --target wasm32-unknown-unknown --target-dir "${SHADER_CARGO_TARGET}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_BINARY_DIR}/bin/$<CONFIG>"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${SHADER_CARGO_TARGET}/wasm32-unknown-unknown/release/azahar_shader_compiler.wasm"
        "${SHADER_COMPILER_OUTPUT}"
    DEPENDS Cargo.toml Cargo.lock src/lib.rs ${NAGA_SOURCES}
        "${PROJECT_SOURCE_DIR}/externals/wgpu/Cargo.toml"
        "${PROJECT_SOURCE_DIR}/externals/wgpu/naga/Cargo.toml"
        "${PROJECT_SOURCE_DIR}/externals/wgpu/naga-types/Cargo.toml"
    VERBATIM)
add_custom_target(azahar_shader_compiler DEPENDS "${SHADER_COMPILER_OUTPUT}")

if(ENABLE_TESTS)
    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    set(NAGA_FIXTURE_ARGS
        --manifest-path "${PROJECT_SOURCE_DIR}/externals/wgpu/naga/Cargo.toml"
        --locked --lib --features glsl-in,wgsl-in,wgsl-out
        --target wasm32-wasip1 --target-dir "${CMAKE_CURRENT_BINARY_DIR}/fixtures"
        --config "target.wasm32-wasip1.runner=['${NODE_EXECUTABLE}','${PROJECT_SOURCE_DIR}/src/web/tests/upstream/run-wasi.mjs']")
    add_custom_target(naga_shader_fixtures
        COMMAND ${SHADER_CARGO_COMMAND} test
            ${NAGA_FIXTURE_ARGS} --no-run
        WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}" VERBATIM)
    if(TARGET browser_core_fixtures)
        add_dependencies(browser_core_fixtures naga_shader_fixtures)
        if(TARGET glslangtests)
            add_dependencies(browser_core_fixtures glslangtests)
        endif()
    endif()
    add_test(NAME naga_shader_fixtures
        COMMAND ${SHADER_CARGO_COMMAND} test
            ${NAGA_FIXTURE_ARGS} -- --test-threads=1 --nocapture
            --skip back::msl::test_error_size --skip proc::typifier::test_error_size)
    # These two original cases assert 64-bit Rust enum sizes; run them on the host.
    add_test(NAME naga_shader_native_layout
        COMMAND ${SHADER_CARGO_COMMAND} test
            --manifest-path "${PROJECT_SOURCE_DIR}/externals/wgpu/naga/Cargo.toml"
            --locked --lib --features glsl-in,wgsl-in,wgsl-out
            --target-dir "${CMAKE_CURRENT_BINARY_DIR}/fixtures" test_error_size)
    set_tests_properties(naga_shader_fixtures PROPERTIES WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}")
    set_tests_properties(naga_shader_native_layout PROPERTIES WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}")
endif()
