// Copyright 2026 Citra Emulator Project / Azahar Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <array>
#include <memory>
#include <vector>
#include "video_core/renderer_base.h"
#include "web/gpu/rasterizer.h"

namespace WebGPU {

class Renderer : public VideoCore::RendererBase {
public:
    Renderer(Core::System& system, Pica::PicaCore& pica, Frontend::EmuWindow& window,
             Frontend::EmuWindow* secondary_window);
    VideoCore::RasterizerInterface* Rasterizer() override { return &rasterizer; }
    void SwapBuffers() override;
    void TryPresent(int timeout_ms, bool secondary) override;

private:
    struct ScreenInfo {
        u32 texture = 0;
        Common::Rectangle<f32> texcoords{0.f, 0.f, 1.f, 1.f};
    };
    struct ScreenQuad {
        u32 left, right, mode;
        f32 opacity, rows;
        std::array<Common::Vec4f, 4> vertices;
    };
    void PrepareScreens();
    void FillScreen(u32 index, u32 color);
    void DrawScreens(const Layout::FramebufferLayout& layout, const Frontend::EmuWindow& window);
    void DrawScreen(const Layout::FramebufferLayout& layout, bool bottom,
                    const Common::Rectangle<u32>& rect, f32 opacity);
    void DrawQuad(u32 left, u32 right, u32 mode, f32 x, f32 y, f32 width, f32 height,
                  bool rotated, f32 opacity);
    void DrawCursor(const Layout::FramebufferLayout& layout, const Frontend::EmuWindow& window);

    Pica::PicaCore& pica;
    WebGPU::Rasterizer rasterizer;
    std::array<std::unique_ptr<Surface>, 3> fills;
    std::array<u32, 3> fill_colors{0xffffffff, 0xffffffff, 0xffffffff};
    std::array<ScreenInfo, 3> screens;
    std::vector<ScreenQuad> quads;
};

} // namespace WebGPU
