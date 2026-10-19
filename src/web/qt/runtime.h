// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <string>
#include <emscripten/val.h>

namespace Web::Qt {

bool InitializeFrontend();
void ShutdownFrontend();
void SetAudioRunning(bool running);
void RegisterRenderSurface(const emscripten::val& canvas, bool secondary);
void UnregisterRenderSurface(const emscripten::val& canvas, bool secondary);
bool InitializeEmulation();
bool YieldEmulation();
void ShutdownEmulation();
std::string EmulationError();

} // namespace Web::Qt
