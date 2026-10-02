// SPDX-License-Identifier: GPL-2.0-or-later

#include <cstdint>
#include <emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE std::uint32_t azahar_web_abi() {
    return 1;
}
