// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <span>
#include <vector>
#include "common/logging/log.h"
#include "video_core/rasterizer_cache/framebuffer_base.h"
#include "video_core/rasterizer_cache/rasterizer_cache_base.h"
#include "video_core/rasterizer_cache/surface_base.h"

namespace WebGPU {

class Surface;

class TextureRuntime {
public:
    u64 GetResourceTick() { return tick++; }
    // Immutable uploads and draw commands run in order on the graphics worker.
    u64 GetResourceFreeTick() const { return tick; }
    void Finish();
    VideoCore::StagingData FindStaging(u32 size, bool upload);
    bool NeedsConversion(const Surface& surface) const;
    bool Reinterpret(Surface& source, Surface& dest, const VideoCore::TextureCopy& copy);
    bool ClearTexture(Surface& surface, const VideoCore::TextureClear& clear);
    bool CopyTextures(Surface& source, Surface& dest, std::span<const VideoCore::TextureCopy> copies);
    bool CopyTextures(Surface& source, Surface& dest, const VideoCore::TextureCopy& copy) {
        return CopyTextures(source, dest, std::span{&copy, 1});
    }
    bool BlitTextures(Surface& source, Surface& dest, const VideoCore::TextureBlit& blit);
    void GenerateMipmaps(Surface& surface);
    u32 CreateTexture(u32 width, u32 height, u32 levels, u32 layers, VideoCore::PixelFormat format);
    void DestroyTexture(u32 handle);
    u32 CreateSampler(const VideoCore::SamplerParams& params);
    void DestroySampler(u32 handle);
    void Blit(u32 source, u32 dest, const VideoCore::TextureBlit& blit);

private:
    u64 tick = 1;
    u32 next_texture = 1;
    u32 next_sampler = 1;
    std::vector<u8> upload_staging;
    std::vector<u8> download_staging;
};

class Surface : public VideoCore::SurfaceBase {
public:
    Surface(TextureRuntime& runtime, const VideoCore::SurfaceParams& params,
            const VideoCore::SurfaceFlagBits& flags = {});
    Surface(TextureRuntime& runtime, const VideoCore::SurfaceBase& surface,
            const VideoCore::Material* material);
    ~Surface();
    Surface(const Surface&) = delete;
    Surface& operator=(const Surface&) = delete;
    Surface(Surface&& other) noexcept;
    Surface& operator=(Surface&& other) noexcept;
    u32 Handle() const { return scaled ? scaled : base; }
    u32 NormalHandle() const { return normal; }
    u32 GetInternalBytesPerPixel() const { return pixel_format == VideoCore::PixelFormat::D16 ? 2 : 4; }
    void Upload(const VideoCore::BufferTextureCopy& copy, const VideoCore::StagingData& staging);
    void Download(const VideoCore::BufferTextureCopy& copy, const VideoCore::StagingData& staging);
    void UploadCustom(const VideoCore::Material* material, u32 level);
    void ScaleUp(u32 scale);

private:
    void Destroy();
    VideoCore::TextureBlit ScaleBlit(const VideoCore::BufferTextureCopy& copy, bool up) const;
    TextureRuntime& runtime;
    u32 base = 0;
    u32 scaled = 0;
    u32 normal = 0;
};

class Framebuffer : public VideoCore::FramebufferParams {
public:
    Framebuffer(TextureRuntime&, const VideoCore::FramebufferParams& params, Surface* color,
                Surface* depth);
    u32 Scale() const { return scale; }
    u32 ColorHandle() const { return color; }
    u32 DepthHandle() const { return depth; }
    VideoCore::PixelFormat ColorFormat() const { return color_format; }
    VideoCore::PixelFormat DepthFormat() const { return depth_format; }

private:
    u32 scale = 1;
    u32 color = 0;
    u32 depth = 0;
    VideoCore::PixelFormat color_format = VideoCore::PixelFormat::Invalid;
    VideoCore::PixelFormat depth_format = VideoCore::PixelFormat::Invalid;
};

class Sampler {
public:
    Sampler(TextureRuntime& runtime, const VideoCore::SamplerParams& params);
    ~Sampler();
    Sampler(const Sampler&) = delete;
    Sampler& operator=(const Sampler&) = delete;
    Sampler(Sampler&& other) noexcept;
    Sampler& operator=(Sampler&& other) noexcept;
    u32 Handle() const { return handle; }

private:
    TextureRuntime& runtime;
    u32 handle = 0;
};

class DebugScope {
public:
    template <typename... Args>
    DebugScope(TextureRuntime&, Common::Vec4f, fmt::format_string<Args...> format, Args... args) {
        LOG_TRACE(Render, "{}", fmt::format(format, std::forward<Args>(args)...));
    }
};

struct Traits {
    using Runtime = TextureRuntime;
    using Surface = WebGPU::Surface;
    using Sampler = WebGPU::Sampler;
    using Framebuffer = WebGPU::Framebuffer;
    using DebugScope = WebGPU::DebugScope;
};

using RasterizerCache = VideoCore::RasterizerCache<Traits>;

} // namespace WebGPU
