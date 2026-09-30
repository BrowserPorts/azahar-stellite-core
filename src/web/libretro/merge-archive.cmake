# SPDX-License-Identifier: GPL-2.0-or-later

get_filename_component(OUTPUT_DIRECTORY "${OUTPUT}" DIRECTORY)
file(MAKE_DIRECTORY "${OUTPUT_DIRECTORY}")
execute_process(COMMAND "${AR}" -M INPUT_FILE "${INPUT}" RESULT_VARIABLE STATUS)
if(NOT STATUS EQUAL 0)
    file(REMOVE "${OUTPUT}.tmp")
    message(FATAL_ERROR "Could not merge the Wasm libretro archive: ${STATUS}")
endif()
file(RENAME "${OUTPUT}.tmp" "${OUTPUT}")
