// Copyright 2020-2026 Citra Emulator Project / Azahar Emulator Project
// Licensed under GPLv2 or any later version
// Refer to the license.txt file included.

#pragma once

#include "common/assert.h"
#include "common/vector_math.h"

namespace Input {

// Map device axes (right, up, out) to 3DS axes (left, out, up).
// Screen rotation is measured in counter-clockwise quarter turns from natural orientation.
inline Common::Vec3<float> TransformMotionAxes(Common::Vec3<float> in, unsigned rotation) {
    Common::Vec3<float> out;
    out.y = in.z;
    switch (rotation) {
    case 0:
        out.x = -in.x;
        out.z = in.y;
        break;
    case 1:
        out.x = in.y;
        out.z = in.x;
        break;
    case 2:
        out.x = in.x;
        out.z = -in.y;
        break;
    case 3:
        out.x = -in.y;
        out.z = -in.x;
        break;
    default:
        UNREACHABLE();
    }
    return out;
}

} // namespace Input
