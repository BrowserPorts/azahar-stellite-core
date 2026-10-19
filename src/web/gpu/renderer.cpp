// Copyright 2023-2026 Citra Emulator Project / Azahar Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <emscripten.h>
#include "common/settings.h"
#include "core/core.h"
#include "core/frontend/emu_window.h"
#include "video_core/pica/pica_core.h"
#include "video_core/rasterizer_cache/rasterizer_cache.h"
#include "web/gpu/renderer.h"

namespace WebGPU {
namespace {

EM_JS(void, PresentScreens, (bool secondary, u32 width, u32 height, f32 r, f32 g, f32 b, bool linear,
                            const u8* quads, u32 count), {
    const p = quads >>> 2;
    const screens = Array.from({length: count}, (_, index) => {
        const offset = p + index * 21;
        return {
            left: HEAPU32[offset], right: HEAPU32[offset + 1], mode: HEAPU32[offset + 2],
            opacity: HEAPF32[offset + 3], rows: HEAPF32[offset + 4],
            vertices: HEAPF32.subarray(offset + 5, offset + 21)
        };
    });
    Module["azaharGraphicsHost"].screens({width, height, background: [r, g, b, 1], linear: linear !== 0, quads: screens}, Number(secondary));
});

} // namespace

Renderer::Renderer(Core::System& system, Pica::PicaCore& pica, Frontend::EmuWindow& window,
                   Frontend::EmuWindow* secondary_window)
    : RendererBase{system, window, secondary_window}, pica{pica},
      rasterizer{system.Memory(), pica, system.CustomTexManager(), *this} {
    static_assert(sizeof(ScreenQuad) == 84 && offsetof(ScreenQuad, vertices) == 20);
    VideoCore::SurfaceParams params;
    params.width = params.height = params.stride = 1;
    params.pixel_format = VideoCore::PixelFormat::RGBA8;
    params.UpdateParams();
    for (u32 i = 0; i < fills.size(); i++) {
        fills[i] = std::make_unique<Surface>(rasterizer.Runtime(), params);
        FillScreen(i, 0);
    }
}

void Renderer::FillScreen(u32 index, u32 color) {
    if (fill_colors[index] != color) {
        rasterizer.Runtime().ClearTexture(*fills[index], VideoCore::TextureClear{
            .texture_level = 0, .texture_layer = 0, .texture_rect = {0, 1, 1, 0},
            .value = {.color = {static_cast<f32>(color & 255) / 255.f,
                               static_cast<f32>((color >> 8) & 255) / 255.f,
                               static_cast<f32>((color >> 16) & 255) / 255.f, 1.f}},
        });
        fill_colors[index] = color;
    }
    screens[index] = {fills[index]->Handle(), {0.f, 0.f, 1.f, 1.f}};
}

void Renderer::PrepareScreens() {
    for (u32 i = 0; i < screens.size(); i++) {
        const u32 fb_id = i == 2 ? 1 : 0;
        const auto& config = pica.regs.framebuffer_config[fb_id];
        const auto fill = fb_id == 0 ? pica.regs_lcd.color_fill_top : pica.regs_lcd.color_fill_bottom;
        if (fill.is_enabled) {
            FillScreen(i, fill.raw & 0xffffff);
            continue;
        }
        const bool right = i == 1 && config.address_right1 != 0 && config.address_right2 != 0;
        const PAddr address = config.active_fb == 0
                                  ? (right ? config.address_right1 : config.address_left1)
                                  : (right ? config.address_right2 : config.address_left2);
        const u32 bpp = Pica::BytesPerPixel(config.color_format);
        if (!address || !bpp || !config.width || !config.height || config.stride % bpp) {
            FillScreen(i, 0);
            continue;
        }
        VideoCore::SurfaceParams params;
        params.addr = address;
        params.stride = config.stride / bpp;
        params.width = std::min(config.width.Value(), params.stride);
        params.height = config.height;
        params.is_tiled = false;
        params.pixel_format = VideoCore::PixelFormatFromGPUPixelFormat(config.color_format);
        if (!params.width) { FillScreen(i, 0); continue; }
        params.UpdateParams();
        const auto [id, rect] = rasterizer.Cache().GetSurfaceSubRect(params, VideoCore::ScaleMatch::Ignore, true);
        if (!id) { FillScreen(i, 0); continue; }
        const auto& surface = rasterizer.Cache().GetSurface(id);
        const f32 width = static_cast<f32>(surface.GetScaledWidth());
        const f32 height = static_cast<f32>(surface.GetScaledHeight());
        // Retain the native Vulkan screen rotation and cached subrectangle coordinates.
        screens[i] = {surface.Handle(), {rect.bottom / height, rect.left / width,
                                       rect.top / height, rect.right / width}};
    }
}

void Renderer::DrawQuad(u32 left, u32 right, u32 mode, f32 x, f32 y, f32 width, f32 height,
                        bool rotated, f32 opacity) {
    if (width <= 0 || height <= 0) return;
    const auto& uv = screens[left].texcoords;
    ScreenQuad quad{.left = screens[left].texture, .right = screens[right].texture,
                    .mode = mode, .opacity = opacity, .rows = rotated ? height : width};
    if (rotated) {
        quad.vertices = {{{x, y, uv.bottom, uv.left}, {x + width, y, uv.bottom, uv.right},
                          {x, y + height, uv.top, uv.left}, {x + width, y + height, uv.top, uv.right}}};
    } else {
        quad.vertices = {{{x, y, uv.bottom, uv.right}, {x + width, y, uv.top, uv.right},
                          {x, y + height, uv.bottom, uv.left}, {x + width, y + height, uv.top, uv.left}}};
    }
    quads.push_back(quad);
}

void Renderer::DrawScreen(const Layout::FramebufferLayout& layout, bool bottom,
                          const Common::Rectangle<u32>& rect, f32 opacity) {
    if (bottom ? !layout.bottom_screen_enabled : !layout.top_screen_enabled) return;
    const u32 left = bottom ? 2 : Settings::values.swap_eyes_3d.GetValue() ? 1 : 0;
    const u32 right = bottom ? 2 : 1 - left;
    const f32 x = static_cast<f32>(rect.left), y = static_cast<f32>(rect.top);
    const f32 width = static_cast<f32>(rect.GetWidth()), height = static_cast<f32>(rect.GetHeight());
    const auto draw = [&](u32 l, u32 r, u32 mode, f32 dx, f32 dw) {
        DrawQuad(l, r, mode, dx, y, dw, height, layout.is_rotated, opacity);
    };
    switch (layout.render_3d_mode) {
    case Settings::StereoRenderOption::Off: {
        const u32 eye = bottom ? 2 : static_cast<u32>(Settings::values.mono_render_option.GetValue());
        draw(eye, eye, 0, x, width);
        break;
    }
    case Settings::StereoRenderOption::SideBySide:
        draw(left, left, 0, x / 2, width / 2);
        draw(right, right, 0, x / 2 + layout.width / 2, width / 2);
        break;
    case Settings::StereoRenderOption::SideBySideFull:
        draw(left, left, 0, x, width);
        draw(right, right, 0, x + layout.width / 2, width);
        break;
    case Settings::StereoRenderOption::CardboardVR:
        draw(left, left, 0, x, width);
        draw(right, right, 0, (bottom ? layout.cardboard.bottom_screen_right_eye : layout.cardboard.top_screen_right_eye) + layout.width / 2, width);
        break;
    case Settings::StereoRenderOption::Anaglyph:
    case Settings::StereoRenderOption::Interlaced:
    case Settings::StereoRenderOption::ReverseInterlaced:
        draw(left, right, static_cast<u32>(layout.render_3d_mode), x, width);
        break;
    }
}

void Renderer::DrawCursor(const Layout::FramebufferLayout& layout, const Frontend::EmuWindow& window) {
    const auto cursor = window.GetCursorInfo();
    if (!cursor.visible || !layout.bottom_screen_enabled) return;
    const auto& rect = layout.bottom_screen;
    const f32 x = rect.left + cursor.projected_x, y = rect.top + cursor.projected_y;
    const f32 ratio = rect.GetHeight() / 60.f;
    const auto bar = [&](f32 dx, f32 dy) {
        const f32 left = std::max(x - dx, static_cast<f32>(rect.left));
        const f32 right = std::min(x + dx, static_cast<f32>(rect.right));
        const f32 top = std::max(y - dy, static_cast<f32>(rect.top));
        const f32 bottom = std::min(y + dy, static_cast<f32>(rect.bottom));
        if (left >= right || top >= bottom) return;
        quads.push_back({.left = 0, .right = 0, .mode = 6, .opacity = 1, .rows = 1,
                         .vertices = {{{left, top, 0, 0}, {right, top, 0, 0},
                                       {left, bottom, 0, 0}, {right, bottom, 0, 0}}}});
    };
    bar(ratio / 5, ratio);
    bar(ratio, ratio / 5);
}

void Renderer::DrawScreens(const Layout::FramebufferLayout& layout, const Frontend::EmuWindow& window) {
    quads.clear();
    if (!Settings::values.swap_screen.GetValue()) {
        DrawScreen(layout, false, layout.top_screen, 1);
        DrawScreen(layout, true, layout.bottom_screen, layout.bottom_opacity);
    } else {
        DrawScreen(layout, true, layout.bottom_screen, 1);
        DrawScreen(layout, false, layout.top_screen, layout.top_opacity);
    }
    if (layout.additional_screen_enabled) {
        DrawScreen(layout, layout.additional_screen_is_bottom, layout.additional_screen, 1);
    }
    DrawCursor(layout, window);
}

void Renderer::TryPresent(int, bool secondary) {
    if (secondary && (!secondary_window ||
                      Settings::values.layout_option.GetValue() != Settings::LayoutOption::SeparateWindows)) {
        return;
    }
    const auto& window = secondary ? *secondary_window : render_window;
    const auto& layout = window.GetFramebufferLayout();
    DrawScreens(layout, window);
    PresentScreens(secondary, layout.width, layout.height, Settings::values.bg_red.GetValue(),
                   Settings::values.bg_green.GetValue(), Settings::values.bg_blue.GetValue(),
                   Settings::values.filter_mode.GetValue(), reinterpret_cast<const u8*>(quads.data()),
                   static_cast<u32>(quads.size()));
}

void Renderer::SwapBuffers() {
    system.perf_stats->StartSwap();
    PrepareScreens();
    render_window.SwapBuffers();
    if (secondary_window &&
        Settings::values.layout_option.GetValue() == Settings::LayoutOption::SeparateWindows) {
        secondary_window->PollEvents();
    }
    system.perf_stats->EndSwap();
    rasterizer.TickFrame();
    EndFrame();
}

} // namespace WebGPU
