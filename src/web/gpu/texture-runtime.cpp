// SPDX-License-Identifier: GPL-2.0-or-later

#include <stdexcept>
#include <utility>
#include <emscripten.h>
#include "video_core/custom_textures/material.h"
#include "video_core/rasterizer_cache/rasterizer_cache.h"
#include "web/gpu/texture-runtime.h"

namespace WebGPU {
namespace {
using namespace VideoCore;

EM_JS(void, CreateTexture, (u32 handle, u32 width, u32 height, u32 levels, u32 layers, u32 format), {
    Module["azaharGraphicsHost"].createTexture(handle, width, height, levels, layers, format);
});
EM_JS(void, DestroyTexture, (u32 handle), {
    Module["azaharGraphicsHost"].destroyTexture(handle);
});
EM_JS(void, CreateSampler, (u32 handle, u32 mag, u32 min, u32 mip, u32 s, u32 t, u32 lod_min, u32 lod_max), {
    Module["azaharGraphicsHost"].createSampler(handle, {
        magFilter: mag, minFilter: min, mipFilter: mip, wrapS: s, wrapT: t, minLod: lod_min, maxLod: lod_max
    });
});
EM_JS(void, DestroySampler, (u32 handle), {
    Module["azaharGraphicsHost"].destroySampler(handle);
});
EM_JS(void, FinishGraphics, (), { Module["azaharGraphicsHost"].finish(); });
EM_JS(void, GenerateMipmaps, (u32 handle), { Module["azaharGraphicsHost"].generateMipmaps(handle); });
EM_JS(void, UploadTexture, (u32 handle, u32 x, u32 y, u32 width, u32 height, u32 level,
                           const u8* data, u32 bytes), {
    Module["azaharGraphicsHost"].uploadTexture(handle, { x, y, width, height, level, layer: 0 },
        HEAPU8.subarray(data, data + bytes));
});
EM_JS(void, DownloadTexture, (u32 handle, u32 x, u32 y, u32 width, u32 height, u32 level,
                             u8* data, u32 bytes), {
    Module["azaharGraphicsHost"].downloadTexture(handle, { x, y, width, height, level, layer: 0 },
        HEAPU8.subarray(data, data + bytes));
});
EM_JS(void, ClearTexture, (u32 handle, u32 x, u32 y, u32 width, u32 height, u32 level, u32 layer,
                          float r, float g, float b, float a, u32 stencil), {
    Module["azaharGraphicsHost"].clearTexture(handle, { x, y, width, height, level, layer },
        [r, g, b, a], stencil);
});
EM_JS(void, CopyTexture, (u32 source, u32 dest, const TextureCopy* copy), {
    const data = copy >>> 2;
    const width = HEAPU32[data + 8], height = HEAPU32[data + 9];
    Module["azaharGraphicsHost"].copyTexture(source, dest, {
        x: HEAPU32[data + 4], y: HEAPU32[data + 5], width, height,
        level: HEAPU32[data], layer: HEAPU32[data + 2]
    }, {
        x: HEAPU32[data + 6], y: HEAPU32[data + 7], width, height,
        level: HEAPU32[data + 1], layer: HEAPU32[data + 3]
    });
});
EM_JS(void, BlitTexture, (u32 source, u32 dest, const TextureBlit* blit), {
    const data = blit >>> 2;
    Module["azaharGraphicsHost"].blitTexture(source, dest, {
        left: HEAPU32[data + 4], top: HEAPU32[data + 5], right: HEAPU32[data + 6], bottom: HEAPU32[data + 7],
        level: HEAPU32[data], layer: HEAPU32[data + 2]
    }, {
        left: HEAPU32[data + 8], top: HEAPU32[data + 9], right: HEAPU32[data + 10], bottom: HEAPU32[data + 11],
        level: HEAPU32[data + 1], layer: HEAPU32[data + 3]
    });
});
static_assert(sizeof(TextureCopy) == 40 && offsetof(TextureCopy, extent) == 32);
static_assert(sizeof(TextureBlit) == 48 && offsetof(TextureBlit, dst_rect) == 32);
static_assert(offsetof(TextureCopy, src_level) == 0 && offsetof(TextureCopy, dst_level) == 4 &&
              offsetof(TextureCopy, src_layer) == 8 && offsetof(TextureCopy, dst_layer) == 12 &&
              offsetof(TextureCopy, src_offset) == 16 && offsetof(TextureCopy, dst_offset) == 24);
static_assert(offsetof(TextureBlit, src_level) == 0 && offsetof(TextureBlit, dst_level) == 4 &&
              offsetof(TextureBlit, src_layer) == 8 && offsetof(TextureBlit, dst_layer) == 12 &&
              offsetof(TextureBlit, src_rect) == 16);
using Rect = Common::Rectangle<u32>;
static_assert(sizeof(Rect) == 16 && offsetof(Rect, left) == 0 && offsetof(Rect, top) == 4 &&
              offsetof(Rect, right) == 8 && offsetof(Rect, bottom) == 12);

} // namespace

void TextureRuntime::Finish() {
    FinishGraphics();
}

StagingData TextureRuntime::FindStaging(u32 size, bool upload) {
    auto& staging = upload ? upload_staging : download_staging;
    staging.resize(size);
    return {.size = size, .offset = 0, .mapped = staging};
}

u32 TextureRuntime::CreateTexture(u32 width, u32 height, u32 levels, u32 layers, PixelFormat format) {
    if (!next_texture) throw std::overflow_error("WebGPU texture handles exhausted");
    const u32 handle = next_texture++;
    WebGPU::CreateTexture(handle, width, height, levels, layers, static_cast<u32>(format));
    return handle;
}

void TextureRuntime::DestroyTexture(u32 handle) {
    if (handle) WebGPU::DestroyTexture(handle);
}

u32 TextureRuntime::CreateSampler(const SamplerParams& params) {
    if (!next_sampler) throw std::overflow_error("WebGPU sampler handles exhausted");
    const u32 handle = next_sampler++;
    WebGPU::CreateSampler(handle, static_cast<u32>(params.mag_filter), static_cast<u32>(params.min_filter),
                         static_cast<u32>(params.mip_filter), static_cast<u32>(params.wrap_s),
                         static_cast<u32>(params.wrap_t), params.lod_min, params.lod_max);
    return handle;
}

void TextureRuntime::DestroySampler(u32 handle) {
    if (handle) WebGPU::DestroySampler(handle);
}

bool TextureRuntime::NeedsConversion(const Surface& surface) const {
    return surface.pixel_format != PixelFormat::D16 && surface.pixel_format != PixelFormat::D24S8;
}

bool TextureRuntime::Reinterpret(Surface&, Surface&, const TextureCopy&) {
    // The native cache flushes the source and decodes the requested format when this returns false.
    return false;
}

bool TextureRuntime::ClearTexture(Surface& surface, const TextureClear& clear) {
    const auto& rect = clear.texture_rect;
    const bool color = surface.type == SurfaceType::Color || surface.type == SurfaceType::Texture;
    const Common::Vec4f value = color ? clear.value.color : Common::Vec4f{clear.value.depth, 0.f, 0.f, 0.f};
    WebGPU::ClearTexture(surface.Handle(), rect.left, rect.bottom, rect.GetWidth(), rect.GetHeight(),
                         clear.texture_level, clear.texture_layer, value.x, value.y, value.z, value.w,
                         surface.type == SurfaceType::DepthStencil ? clear.value.stencil : 0);
    return true;
}

bool TextureRuntime::CopyTextures(Surface& source, Surface& dest, std::span<const TextureCopy> copies) {
    for (const auto& copy : copies) CopyTexture(source.Handle(), dest.Handle(), &copy);
    return true;
}

void TextureRuntime::Blit(u32 source, u32 dest, const TextureBlit& blit) {
    BlitTexture(source, dest, &blit);
}

bool TextureRuntime::BlitTextures(Surface& source, Surface& dest, const TextureBlit& blit) {
    Blit(source.Handle(), dest.Handle(), blit);
    return true;
}

void TextureRuntime::GenerateMipmaps(Surface& surface) {
    WebGPU::GenerateMipmaps(surface.Handle());
}

Surface::Surface(TextureRuntime& runtime_, const SurfaceParams& params, const SurfaceFlagBits& flags)
    : SurfaceBase{params, flags}, runtime{runtime_} {
    if (type == SurfaceType::Fill) return;
    const u32 layers = texture_type == TextureType::CubeMap ? 6 : 1;
    base = runtime.CreateTexture(width, height, levels, layers, pixel_format);
    if (res_scale != 1) scaled = runtime.CreateTexture(GetScaledWidth(), GetScaledHeight(), levels, layers, pixel_format);
}

Surface::Surface(TextureRuntime& runtime_, const SurfaceBase& surface, const Material* material_)
    : SurfaceBase{surface}, runtime{runtime_} {
    if (material_->format != CustomPixelFormat::RGBA8) {
        throw std::runtime_error("Compressed custom textures are not available in WebGPU");
    }
    material = material_;
    custom_format = material->format;
    base = runtime.CreateTexture(material->width, material->height, levels, 1, PixelFormat::RGBA8);
    if (material->Map(MapType::Normal)) normal = runtime.CreateTexture(material->width, material->height, levels, 1, PixelFormat::RGBA8);
}

Surface::~Surface() { Destroy(); }

Surface::Surface(Surface&& other) noexcept
    : SurfaceBase{std::move(other)}, runtime{other.runtime}, base{std::exchange(other.base, 0)},
      scaled{std::exchange(other.scaled, 0)}, normal{std::exchange(other.normal, 0)} {}

Surface& Surface::operator=(Surface&& other) noexcept {
    if (this == &other) return *this;
    Destroy();
    SurfaceBase::operator=(std::move(other));
    base = std::exchange(other.base, 0);
    scaled = std::exchange(other.scaled, 0);
    normal = std::exchange(other.normal, 0);
    return *this;
}

void Surface::Destroy() {
    runtime.DestroyTexture(std::exchange(base, 0));
    runtime.DestroyTexture(std::exchange(scaled, 0));
    runtime.DestroyTexture(std::exchange(normal, 0));
}

TextureBlit Surface::ScaleBlit(const BufferTextureCopy& copy, bool up) const {
    const auto rect = copy.texture_rect;
    return {.src_level = copy.texture_level, .dst_level = copy.texture_level,
            .src_rect = up ? rect : rect * res_scale, .dst_rect = up ? rect * res_scale : rect};
}

void Surface::Upload(const BufferTextureCopy& copy, const StagingData& staging) {
    const auto& rect = copy.texture_rect;
    const u32 bytes = rect.GetArea() * GetInternalBytesPerPixel();
    ASSERT(bytes <= staging.mapped.size());
    UploadTexture(base, rect.left, rect.bottom, rect.GetWidth(), rect.GetHeight(), copy.texture_level,
                  staging.mapped.data(), bytes);
    if (scaled) runtime.Blit(base, scaled, ScaleBlit(copy, true));
}

void Surface::Download(const BufferTextureCopy& copy, const StagingData& staging) {
    if (scaled) runtime.Blit(scaled, base, ScaleBlit(copy, false));
    const auto& rect = copy.texture_rect;
    const u32 bytes = rect.GetArea() * GetInternalBytesPerPixel();
    ASSERT(bytes <= staging.mapped.size());
    DownloadTexture(base, rect.left, rect.bottom, rect.GetWidth(), rect.GetHeight(), copy.texture_level,
                    staging.mapped.data(), bytes);
}

void Surface::UploadCustom(const Material* material_, u32 level) {
    const auto upload = [&](u32 handle, const CustomTexture* texture) {
        if (!texture || !handle) return;
        if (texture->format != CustomPixelFormat::RGBA8) throw std::runtime_error("Unsupported custom texture format");
        UploadTexture(handle, 0, 0, texture->width, texture->height, level, texture->data.data(),
                      static_cast<u32>(texture->data.size()));
    };
    upload(base, material_->Map(MapType::Color));
    upload(normal, material_->Map(MapType::Normal));
}

void Surface::ScaleUp(u32 scale) {
    if (scale <= res_scale) return;
    const u32 previous = Handle();
    const u32 next = runtime.CreateTexture(width * scale, height * scale, levels,
                                          texture_type == TextureType::CubeMap ? 6 : 1, pixel_format);
    const u32 layers = texture_type == TextureType::CubeMap ? 6 : 1;
    for (u32 layer = 0; layer < layers; layer++) {
        for (u32 level = 0; level < levels; level++) {
            runtime.Blit(previous, next, {.src_level = level, .dst_level = level,
                         .src_layer = layer, .dst_layer = layer, .src_rect = GetScaledRect(level),
                         .dst_rect = {0, (height * scale) >> level, (width * scale) >> level, 0}});
        }
    }
    runtime.DestroyTexture(scaled);
    scaled = next;
    res_scale = scale;
}

Framebuffer::Framebuffer(TextureRuntime&, const FramebufferParams& params, Surface* color_, Surface* depth_)
    : FramebufferParams{params} {
    if (color_) { color = color_->Handle(); color_format = color_->pixel_format; scale = color_->res_scale; }
    if (depth_) { depth = depth_->Handle(); depth_format = depth_->pixel_format; scale = depth_->res_scale; }
}

Sampler::Sampler(TextureRuntime& runtime_, const SamplerParams& params)
    : runtime{runtime_}, handle{runtime.CreateSampler(params)} {}
Sampler::~Sampler() { runtime.DestroySampler(handle); }
Sampler::Sampler(Sampler&& other) noexcept
    : runtime{other.runtime}, handle{std::exchange(other.handle, 0)} {}
Sampler& Sampler::operator=(Sampler&& other) noexcept {
    if (this == &other) return *this;
    runtime.DestroySampler(handle);
    handle = std::exchange(other.handle, 0);
    return *this;
}

} // namespace WebGPU

namespace VideoCore {
template class RasterizerCache<WebGPU::Traits>;
}
