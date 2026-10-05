// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <unordered_map>
#include "video_core/rasterizer_accelerated.h"
#include "video_core/shader/generator/shader_gen.h"
#include "web/gpu/texture-runtime.h"

namespace WebGPU {

class Rasterizer : public VideoCore::RasterizerAccelerated {
public:
    Rasterizer(Memory::MemorySystem& memory, Pica::PicaCore& pica,
               VideoCore::CustomTexManager& custom_textures, VideoCore::RendererBase& renderer);
    ~Rasterizer() override;
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
    struct VertexProgram {
        u32 handle;
        u32 input_mask;
    };
    void DrawBatch(std::span<const u8> vertices, u32 program = 0,
                   const Pica::Shader::Generator::VSPicaUniformData* uniforms = nullptr,
                   std::span<const u32> indices = {});
    bool DrawProgrammable(bool is_indexed, const VertexArrayInfo& vertex_info);
    void ClearPrograms();
    void SyncLookupTables();
    u32 TextureCube(const Pica::TexturingRegs::FullTextureConfig& texture);
    TextureRuntime runtime;
    RasterizerCache cache;
    std::array<Common::Vec2f, 24 * 256 + 128> lighting_lut{};
    std::array<Common::Vec2f, 128 * 3> proctex_lut{};
    std::array<Common::Vec4f, 256 * 2> proctex_color{};
    std::unordered_map<Pica::Shader::Generator::PicaVSConfig, VertexProgram> vertex_programs;
};

} // namespace WebGPU
