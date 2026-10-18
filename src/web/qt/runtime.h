// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <emscripten/val.h>

namespace Web::Qt {

bool InitializeFrontend();
void ShutdownFrontend();
void RegisterRenderSurface(const emscripten::val& canvas);
void UnregisterRenderSurface(const emscripten::val& canvas);

} // namespace Web::Qt
