# SPDX-License-Identifier: GPL-2.0-or-later

set(CUBEB_ROOT "${AZAHAR_ROOT}/externals/cubeb")
add_subdirectory("${AZAHAR_ROOT}/externals/speex-resampler"
    "${CMAKE_CURRENT_BINARY_DIR}/speex-resampler" EXCLUDE_FROM_ALL)
if(NOT TARGET gtest_main)
    set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
    add_subdirectory("${CUBEB_ROOT}/googletest"
        "${CMAKE_CURRENT_BINARY_DIR}/cubeb-googletest" EXCLUDE_FROM_ALL)
endif()

# Compile the original resampler and logging components used by the native cases.
add_library(cubeb_fixture_resampler STATIC
    "${CUBEB_ROOT}/src/cubeb_resampler.cpp"
    "${CUBEB_ROOT}/src/cubeb_log.cpp")
include(GenerateExportHeader)
generate_export_header(cubeb_fixture_resampler BASE_NAME CUBEB
    EXPORT_FILE_NAME "${CMAKE_CURRENT_BINARY_DIR}/cubeb-exports/cubeb_export.h")
target_include_directories(cubeb_fixture_resampler PUBLIC
    "${CUBEB_ROOT}/include" "${CUBEB_ROOT}/src" "${CMAKE_CURRENT_BINARY_DIR}/cubeb-exports")
target_link_libraries(cubeb_fixture_resampler PUBLIC azahar_speex_resampler)

add_executable(cubeb_resampler_fixtures "${CUBEB_ROOT}/test/test_resampler.cpp")
target_link_libraries(cubeb_resampler_fixtures PRIVATE cubeb_fixture_resampler gtest_main)
foreach(target IN ITEMS cubeb_fixture_resampler cubeb_resampler_fixtures azahar_speex_resampler)
    if(MSVC)
        target_compile_options(${target} PRIVATE /UNDEBUG)
    else()
        target_compile_options(${target} PRIVATE -UNDEBUG)
    endif()
endforeach()
register_fixture(cubeb_resampler_fixtures)
add_dependencies(upstream_fixtures cubeb_resampler_fixtures)
