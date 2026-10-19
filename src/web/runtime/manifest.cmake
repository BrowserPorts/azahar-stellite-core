# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.25)

if (NOT FILES OR NOT OUTPUT)
    message(FATAL_ERROR "Runtime manifest needs FILES and OUTPUT")
endif()

list(SORT FILES COMPARE FILE_BASENAME)
set(NAMES)
set(ENTRIES)
set(FINGERPRINT "azahar-web\n")
foreach(INPUT IN LISTS FILES)
    get_filename_component(NAME "${INPUT}" NAME)
    if (NAME IN_LIST NAMES)
        message(FATAL_ERROR "Duplicate runtime asset: ${NAME}")
    endif()
    list(APPEND NAMES "${NAME}")
    file(SIZE "${INPUT}" SIZE)
    if (SIZE EQUAL 0)
        message(FATAL_ERROR "Empty runtime asset: ${NAME}")
    endif()
    file(SHA256 "${INPUT}" HASH)
    string(APPEND FINGERPRINT "${NAME}:${HASH}\n")
    list(APPEND ENTRIES "{\"name\":\"${NAME}\",\"sha256\":\"${HASH}\",\"size\":${SIZE}}")
endforeach()

string(SHA256 VERSION "${FINGERPRINT}")
list(JOIN ENTRIES ",\n    " FILES_JSON)
file(WRITE "${OUTPUT}.tmp"
    "{\n  \"id\": \"azahar-web\",\n  \"runtime\": \"azahar-web\",\n  \"version\": \"${VERSION}\",\n"
    "  \"license\": \"GPL-2.0-or-later\",\n  \"files\": [\n    ${FILES_JSON}\n  ]\n}\n")
file(RENAME "${OUTPUT}.tmp" "${OUTPUT}")
