// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "video_core/rasterizer_accelerated.h"
#include "web/gpu/texture-runtime.h"

namespace WebGPU {

class Rasterizer : public VideoCore::RasterizerAccelerated {
public:
    Rasterizer(Memory::MemorySystem& memory, Pica::PicaCore& pica,
               VideoCore::CustomTexManager& custom_textures, VideoCore::RendererBase& renderer);
    void DrawTriangles() override;
    bool AccelerateDrawBatch(bool is_indexed) override;
    void FlushAll() override;
    void FlushRegion(PAddr addr, u32 size) override;
    void InvalidateRegion(PAddr addr, u32 size) override;
    void FlushAndInvalidateRegion(PAddr addr, u32 size) override;
    void ClearAll(bool flush) override;
    bool AccelerateDisplayTransfer(const Pica::DisplayTransferConfig& config) override;
    bool AccelerateTextureCopy(const Pica::DisplayTransferConfig& config) override;
    bool AccelerateFill(const Pica::MemoryFillConfig& config) override;
    void TickFrame();
    RasterizerCache& Cache() { return cache; }
    TextureRuntime& Runtime() { return runtime; }

private:
    void SyncLookupTables();
    u32 TextureCube(const Pica::TexturingRegs::FullTextureConfig& texture);
    TextureRuntime runtime;
    RasterizerCache cache;
    std::array<Common::Vec2f, 24 * 256 + 128> lighting_lut{};
    std::array<Common::Vec2f, 128 * 3> proctex_lut{};
    std::array<Common::Vec4f, 256 * 2> proctex_color{};
};

} // namespace WebGPU
