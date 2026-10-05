# SPDX-License-Identifier: GPL-2.0-or-later

# Reuse Cubeb's pinned Speex component without its platform audio backends.
add_library(azahar_speex_resampler STATIC ../cubeb/subprojects/speex/resample.c)
set_target_properties(azahar_speex_resampler PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(azahar_speex_resampler PUBLIC ../cubeb/subprojects)
target_compile_definitions(azahar_speex_resampler
    PUBLIC OUTSIDE_SPEEX FLOATING_POINT RANDOM_PREFIX=azahar_speex
    PRIVATE EXPORT=)
