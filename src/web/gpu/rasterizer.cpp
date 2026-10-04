// SPDX-License-Identifier: GPL-2.0-or-later

#include <bit>
#include <emscripten.h>
#include "video_core/pica/pica_core.h"
#include "video_core/rasterizer_cache/rasterizer_cache.h"
#include "web/gpu/rasterizer.h"

namespace WebGPU {
namespace {

struct DrawState {
    u32 color, depth, color_level, depth_level;
    u32 cull, flipped, color_mask, depth_write, depth_compare;
    u32 stencil, stencil_compare, stencil_fail, stencil_depth_fail, stencil_pass;
    u32 stencil_read_mask, stencil_write_mask, stencil_reference;
    u32 blend, rgb_equation, alpha_equation, rgb_source, rgb_dest, alpha_source, alpha_dest;
    u32 blend_color, logic_op, texture0_type;
    std::array<u32, 3> textures, samplers;
    u32 normal, shadow;
    VideoCore::ViewportInfo viewport;
    std::array<u32, 4> scissor;
};
static_assert(sizeof(DrawState) == 43 * sizeof(u32));
static_assert(offsetof(DrawState, textures) == 27 * sizeof(u32) &&
              offsetof(DrawState, samplers) == 30 * sizeof(u32) &&
              offsetof(DrawState, viewport) == 35 * sizeof(u32) &&
              offsetof(DrawState, scissor) == 39 * sizeof(u32));

EM_JS(void, CheckShaderABI, (u32 size, u64 schema), {
    const host = Module["azaharGraphicsHost"];
    if (host.configurationSize !== size || host.configurationSchema !== BigInt.asUintN(64, schema)) {
        throw new Error("The core and graphics worker use incompatible native PICA configurations");
    }
});
EM_JS(void, UploadLookupTable, (u32 table, u32 offset, const u8* pointer, u32 size), {
    Module["azaharGraphicsHost"].lookupTable(table, offset, HEAPU8.subarray(pointer, pointer + size));
});
EM_JS(void, DrawTriangles, (const DrawState* state, const u8* config, u32 config_size,
                           const u8* vertices, u32 vertex_bytes, const u8* vs, const u8* fs), {
    Module["azaharGraphicsHost"].draw(HEAPU8.subarray(state, state + 43 * 4),
       HEAPU8.subarray(config, config + config_size), HEAPU8.subarray(vertices, vertices + vertex_bytes),
       HEAPU8.subarray(vs, vs + 32), HEAPU8.subarray(fs, fs + 0x530));
});

} // namespace

Rasterizer::Rasterizer(Memory::MemorySystem& memory, Pica::PicaCore& pica,
                       VideoCore::CustomTexManager& custom_textures, VideoCore::RendererBase& renderer)
    : RasterizerAccelerated{memory, pica}, cache{memory, custom_textures, runtime, regs, renderer} {
    CheckShaderABI(sizeof(Pica::Shader::FSConfig), Pica::Shader::FSConfig::StructHash());
    pica.lighting.lut_dirty = pica.lighting.LutAllDirty;
    pica.fog.lut_dirty = true;
    pica.proctex.table_dirty = pica.proctex.TableAllDirty;
}

void Rasterizer::DrawTriangles() {
    if (vertex_batch.empty()) return;
    SyncDrawUniforms();
    const auto& fb = regs.framebuffer;
    const auto& om = fb.output_merger;
    const auto& blend = om.alpha_blending;
    const auto& stencil = om.stencil_test;
    const bool shadow = fb.IsShadowRendering();
    const bool using_color = fb.framebuffer.GetColorBufferPhysicalAddress() != 0;
    const bool stencil_enabled = fb.HasStencil() && stencil.enable;
    const bool using_depth = !shadow && fb.framebuffer.GetDepthBufferPhysicalAddress() != 0 &&
                             (om.depth_test_enable || om.depth_write_enable || stencil_enabled);
    const auto helper = cache.GetFramebufferSurfaces(using_color, using_depth);
    const auto* framebuffer = helper.Framebuffer();
    const auto draw_rect = helper.DrawRect();
    if ((!framebuffer->ColorHandle() && !framebuffer->DepthHandle()) || !draw_rect.GetArea()) {
        vertex_batch.clear();
        return;
    }
    const auto scissor = helper.Scissor();
    fs_data.framebuffer_scale = framebuffer->Scale();
    fs_data.scissor_x1 = scissor.left;
    fs_data.scissor_y1 = scissor.bottom;
    fs_data.scissor_x2 = scissor.right;
    fs_data.scissor_y2 = scissor.top;
    DrawState state{
        .color = framebuffer->ColorHandle(), .depth = framebuffer->DepthHandle(),
        .color_level = framebuffer->color_level, .depth_level = framebuffer->depth_level,
        .cull = static_cast<u32>(regs.rasterizer.cull_mode.Value()), .flipped = vs_data.flip_viewport,
        .color_mask = fb.framebuffer.allow_color_write ? (om.depth_color_mask >> 8) & 15 : 0,
        .depth_write = fb.framebuffer.allow_depth_stencil_write && om.depth_write_enable,
        .depth_compare = static_cast<u32>(om.depth_test_enable ? om.depth_test_func.Value() : Pica::FramebufferRegs::CompareFunc::Always),
        .stencil = stencil_enabled, .stencil_compare = static_cast<u32>(stencil.func.Value()),
        .stencil_fail = static_cast<u32>(stencil.action_stencil_fail.Value()),
        .stencil_depth_fail = static_cast<u32>(stencil.action_depth_fail.Value()),
        .stencil_pass = static_cast<u32>(stencil.action_depth_pass.Value()),
        .stencil_read_mask = stencil.input_mask,
        .stencil_write_mask = fb.framebuffer.allow_depth_stencil_write ? stencil.write_mask.Value() : 0,
        .stencil_reference = stencil.reference_value,
        .blend = om.alphablend_enable, .rgb_equation = static_cast<u32>(blend.blend_equation_rgb.Value()),
        .alpha_equation = static_cast<u32>(blend.blend_equation_a.Value()),
        .rgb_source = static_cast<u32>(blend.factor_source_rgb.Value()),
        .rgb_dest = static_cast<u32>(blend.factor_dest_rgb.Value()),
        .alpha_source = static_cast<u32>(blend.factor_source_a.Value()),
        .alpha_dest = static_cast<u32>(blend.factor_dest_a.Value()), .blend_color = om.blend_const.raw,
        .logic_op = static_cast<u32>(om.logic_op.Value()),
        .texture0_type = static_cast<u32>(regs.texturing.texture0.type.Value()),
        .shadow = shadow, .viewport = helper.Viewport(),
        .scissor = {draw_rect.left, draw_rect.bottom, draw_rect.GetWidth(), draw_rect.GetHeight()},
    };
    const auto textures = regs.texturing.GetTextures();
    for (u32 unit = 0; unit < textures.size(); unit++) {
        const auto& texture = textures[unit];
        const bool cube = unit == 0 && (state.texture0_type == 1 || state.texture0_type == 4);
        if (!texture.enabled) {
            state.textures[unit] = cache.GetSurface(cube ? VideoCore::NULL_SURFACE_CUBE_ID : VideoCore::NULL_SURFACE_ID).Handle();
            state.samplers[unit] = cache.GetSampler(VideoCore::NULL_SAMPLER_ID).Handle();
        } else {
            state.samplers[unit] = cache.GetSampler(texture.config).Handle();
            if (cube) {
                state.textures[unit] = TextureCube(texture);
            } else {
                auto& surface = cache.GetTextureSurface(texture);
                state.textures[unit] = surface.Handle();
                if (unit == 0) state.normal = surface.NormalHandle();
            }
        }
    }
    SyncLookupTables();
    const Pica::Shader::FSConfig config{regs};
    WebGPU::DrawTriangles(&state, reinterpret_cast<const u8*>(&config), sizeof(config),
                          reinterpret_cast<const u8*>(vertex_batch.data()),
                          static_cast<u32>(vertex_batch.size() * sizeof(HardwareVertex)),
                          reinterpret_cast<const u8*>(&vs_data), reinterpret_cast<const u8*>(&fs_data));
    vertex_batch.clear();
}

bool Rasterizer::AccelerateDrawBatch(bool is_indexed) {
    const auto vertices = AnalyzeVertexArray(is_indexed);
    if (vertices.Invalid()) return true;

    const auto& attributes = regs.pipeline.vertex_attributes;
    const u32 count = vertices.vs_input_index_max - vertices.vs_input_index_min + 1;
    for (const auto& loader : attributes.attribute_loaders) {
        if (loader.component_count == 0 || loader.byte_count == 0) continue;
        const PAddr address = attributes.GetPhysicalBaseAddress() + loader.data_offset +
                              vertices.vs_input_index_min * loader.byte_count;
        cache.FlushRegion(address, count * loader.byte_count);
    }

    pica.LoadVertices(is_indexed, true);
    DrawTriangles();
    return true;
}

u32 Rasterizer::TextureCube(const Pica::TexturingRegs::FullTextureConfig& texture) {
    using Face = Pica::TexturingRegs::CubeFace;
    const VideoCore::TextureCubeConfig config{
        .px = regs.texturing.GetCubePhysicalAddress(Face::PositiveX),
        .nx = regs.texturing.GetCubePhysicalAddress(Face::NegativeX),
        .py = regs.texturing.GetCubePhysicalAddress(Face::PositiveY),
        .ny = regs.texturing.GetCubePhysicalAddress(Face::NegativeY),
        .pz = regs.texturing.GetCubePhysicalAddress(Face::PositiveZ),
        .nz = regs.texturing.GetCubePhysicalAddress(Face::NegativeZ),
        .width = texture.config.width, .levels = texture.config.lod.max_level + 1, .format = texture.format,
    };
    return cache.GetTextureCube(config).Handle();
}

void Rasterizer::SyncLookupTables() {
    const auto upload = [](u32 table, u32 offset, const auto& span) {
        UploadLookupTable(table, offset * sizeof(typename std::remove_reference_t<decltype(span)>::element_type),
                          reinterpret_cast<const u8*>(span.data()), static_cast<u32>(span.size_bytes()));
    };
    while (pica.lighting.lut_dirty) {
        const u32 index = std::countr_zero(pica.lighting.lut_dirty);
        pica.lighting.lut_dirty &= ~(1 << index);
        const auto& source = pica.lighting.luts[index];
        for (u32 i = 0; i < source.size(); i++) lighting_lut[index * 256 + i] = {source[i].ToFloat(), source[i].DiffToFloat()};
        fs_data.lighting_lut_offset[index / 4][index % 4] = static_cast<int>(index * 256);
        upload(0, index * 256, std::span{lighting_lut}.subspan(index * 256, 256));
    }
    if (pica.fog.lut_dirty) {
        constexpr u32 offset = 24 * 256;
        for (u32 i = 0; i < pica.fog.lut.size(); i++) lighting_lut[offset + i] = {pica.fog.lut[i].ToFloat(), pica.fog.lut[i].DiffToFloat()};
        fs_data.fog_lut_offset = offset;
        upload(0, offset, std::span{lighting_lut}.subspan(offset, 128));
        pica.fog.lut_dirty = false;
    }
    const auto value_lut = [&](const auto& source, u32 offset, int& uniform) {
        for (u32 i = 0; i < source.size(); i++) proctex_lut[offset + i] = {source[i].ToFloat(), source[i].DiffToFloat()};
        uniform = static_cast<int>(offset);
        upload(1, offset, std::span{proctex_lut}.subspan(offset, 128));
    };
    if (pica.proctex.noise_lut_dirty) value_lut(pica.proctex.noise_table, 0, fs_data.proctex_noise_lut_offset);
    if (pica.proctex.color_map_dirty) value_lut(pica.proctex.color_map_table, 128, fs_data.proctex_color_map_offset);
    if (pica.proctex.alpha_map_dirty) value_lut(pica.proctex.alpha_map_table, 256, fs_data.proctex_alpha_map_offset);
    const auto color_lut = [&](const auto& source, u32 offset, int& uniform) {
        for (u32 i = 0; i < source.size(); i++) proctex_color[offset + i] = source[i].ToVector() / 255.0f;
        uniform = static_cast<int>(offset);
        upload(2, offset, std::span{proctex_color}.subspan(offset, 256));
    };
    if (pica.proctex.lut_dirty) color_lut(pica.proctex.color_table, 0, fs_data.proctex_lut_offset);
    if (pica.proctex.diff_lut_dirty) color_lut(pica.proctex.color_diff_table, 256, fs_data.proctex_diff_lut_offset);
    pica.proctex.table_dirty = 0;
}

void Rasterizer::FlushAll() { cache.FlushAll(); }
void Rasterizer::FlushRegion(PAddr addr, u32 size) { cache.FlushRegion(addr, size); }
void Rasterizer::InvalidateRegion(PAddr addr, u32 size) { cache.InvalidateRegion(addr, size); }
void Rasterizer::FlushAndInvalidateRegion(PAddr addr, u32 size) { cache.FlushRegion(addr, size); cache.InvalidateRegion(addr, size); }
void Rasterizer::ClearAll(bool flush) { cache.ClearAll(flush); vertex_batch.clear(); }
bool Rasterizer::AccelerateDisplayTransfer(const Pica::DisplayTransferConfig& config) { return cache.AccelerateDisplayTransfer(config); }
bool Rasterizer::AccelerateTextureCopy(const Pica::DisplayTransferConfig& config) { return cache.AccelerateTextureCopy(config); }
bool Rasterizer::AccelerateFill(const Pica::MemoryFillConfig& config) { return cache.AccelerateFill(config); }
void Rasterizer::TickFrame() { cache.TickFrame(); }

} // namespace WebGPU
