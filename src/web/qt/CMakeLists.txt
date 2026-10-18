# SPDX-License-Identifier: GPL-2.0-or-later

azahar_enable_dsp_runtime(citra_meta)
target_sources(citra_meta PRIVATE runtime.cpp runtime.h ../runtime/file-system.cpp)
target_link_libraries(citra_meta PRIVATE emscripten_opfs cryptopp)
target_include_directories(citra_meta PRIVATE
    "${EMSCRIPTEN_ROOT_PATH}/system/lib/wasmfs")
if (CMAKE_CONFIGURATION_TYPES)
    set(QT_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
else()
    set(QT_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/${CMAKE_BUILD_TYPE}")
endif()
set_target_properties(citra_meta PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${QT_OUTPUT_DIRECTORY}"
    QT_WASM_EXPORT_NAME createAzaharQt
    QT_WASM_INITIAL_MEMORY 536870912
    QT_WASM_MAXIMUM_MEMORY 2147483648
    QT_WASM_PTHREAD_POOL_SIZE 16
    QT_WASM_EXTRA_EXPORTED_METHODS "HEAPU8,HEAPU32,HEAP16,UTF8ToString,stringToNewUTF8")
target_link_options(citra_meta PRIVATE
    --emit-symbol-map
    "SHELL:--pre-js \"${CMAKE_CURRENT_SOURCE_DIR}/bootstrap.js\""
    "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/emulation.js\""
    "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/../runtime/file-system.js\""
    -sENVIRONMENT=web,worker -sDYNAMIC_EXECUTION=0 -sPTHREAD_POOL_SIZE_STRICT=2)
set_property(TARGET citra_meta APPEND PROPERTY LINK_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/bootstrap.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/emulation.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/../runtime/file-system.js")

find_program(BUN_EXECUTABLE NAMES bun REQUIRED)
set(QT_RUNTIME "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-qt-runtime.js")
set(QT_EMULATION_RUNTIME "${CMAKE_BINARY_DIR}/bin/$<CONFIG>/azahar-qt-emulation.js")
add_custom_command(OUTPUT "${QT_RUNTIME}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/runtime.ts"
        --target browser --outfile "${QT_RUNTIME}"
    DEPENDS runtime.ts ../runtime/storage-lock.ts
    VERBATIM)
file(GLOB QT_EMULATION_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/../arm/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/../pica/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/../gpu/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/../wasm/*.ts")
add_custom_command(OUTPUT "${QT_EMULATION_RUNTIME}"
    COMMAND "${BUN_EXECUTABLE}" build "${CMAKE_CURRENT_SOURCE_DIR}/emulation.ts"
        --target browser --outfile "${QT_EMULATION_RUNTIME}"
    DEPENDS emulation.ts ${QT_EMULATION_SOURCES}
    VERBATIM)
add_custom_target(azahar_qt_runtime DEPENDS citra_meta azahar_graphics_runtime
    "${QT_RUNTIME}" "${QT_EMULATION_RUNTIME}")
