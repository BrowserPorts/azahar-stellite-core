// Copyright 2026 Citra Emulator Project / Azahar Emulator Project
// Licensed under GPLv2 or any later version
// Refer to the license.txt file included.

#pragma once

#include "core/core.h"
#include "emu_window/libretro_window.h"

namespace LibRetro {
/// Runs until the next video frame, returning false if emulation stops or fails.
bool RunFrame();
/// Reloads the current game, optionally applying pending frontend options before loading.
bool ResetGame(bool update_settings = false);
/// Finish pending host I/O before a save or storage flush.
bool DrainAsyncOperations(Core::System& system);
} // namespace LibRetro
