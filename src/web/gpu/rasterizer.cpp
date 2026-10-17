// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <bit>
#include <cstring>
#include <limits>
#include <emscripten.h>
#include <wasm_simd128.h>
#include "video_core/pica/pica_core.h"
#include "video_core/pica/vertex_loader.h"
#include "video_core/rasterizer_cache/rasterizer_cache.h"
#include "video_core/shader/generator/glsl_shader_gen.h"
#include "web/gpu/rasterizer.h"

namespace WebGPU {
namespace {

bool EqualDrawStateBytes(const u8* cached, std::span<const std::byte> current) {
    std::size_t offset = 0;
    for (; offset + sizeof(v128_t) <= current.size(); offset += sizeof(v128_t)) {
        const auto difference = wasm_v128_xor(wasm_v128_load(cached + offset),
                                              wasm_v128_load(current.data() + offset));
        if (wasm_v128_any_true(difference)) return false;
    }
    for (; offset < current.size(); ++offset) {
        if (cached[offset] != static_cast<u8>(current[offset])) return false;
    }
    return true;
}

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
                           const u8* vertices, u32 vertex_bytes, const u8* vs, const u8* fs,
                           u32 program, const u8* uniforms, const u32* indices, u32 index_bytes,
                           bool same_state), {
    Module["azaharGraphicsHost"].draw(HEAPU8.subarray(state, state + 43 * 4),
       HEAPU8.subarray(config, config + config_size), HEAPU8.subarray(vertices, vertices + vertex_bytes),
       HEAPU8.subarray(vs, vs + 32), HEAPU8.subarray(fs, fs + 0x530), program,
       uniforms ? HEAPU8.subarray(uniforms, uniforms + 1616) : undefined,
       index_bytes ? HEAPU8.subarray(indices, indices + index_bytes) : undefined,
       same_state !== 0);
});
EM_JS(u32, CreateVertexProgram, (const char* source, u32 input_mask), {
    return Module["azaharGraphicsHost"].createVertexProgram(UTF8ToString(source), input_mask);
});
EM_JS(void, DestroyVertexProgram, (u32 program), {
    Module["azaharGraphicsHost"].destroyVertexProgram(program);
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
    DrawBatch({reinterpret_cast<const u8*>(vertex_batch.data()),
               vertex_batch.size() * sizeof(HardwareVertex)});
    vertex_batch.clear();
}

Rasterizer::~Rasterizer() {
    ClearPrograms();
}

void Rasterizer::DrawBatch(std::span<const u8> vertices, u32 program,
                          const Pica::Shader::Generator::VSPicaUniformData* uniforms,
                          std::span<const u32> indices) {
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
    const std::array<std::span<const std::byte>, 4> state_parts{
        std::as_bytes(std::span{&state, 1}), std::as_bytes(std::span{&config, 1}),
        std::as_bytes(std::span{&vs_data, 1}), std::as_bytes(std::span{&fs_data, 1}),
    };
    constexpr std::size_t state_size =
        sizeof(state) + sizeof(config) + sizeof(vs_data) + sizeof(fs_data);
    bool same_state = !program && immediate_state_valid && immediate_state.size() == state_size;
    if (same_state) {
        std::size_t offset = 0;
        for (const auto part : state_parts) {
            if (!EqualDrawStateBytes(immediate_state.data() + offset, part)) {
                same_state = false;
                break;
            }
            offset += part.size();
        }
    }
    immediate_state_valid = false;
    WebGPU::DrawTriangles(&state, reinterpret_cast<const u8*>(&config), sizeof(config),
                          vertices.data(), static_cast<u32>(vertices.size()),
                          reinterpret_cast<const u8*>(&vs_data), reinterpret_cast<const u8*>(&fs_data),
                          program, reinterpret_cast<const u8*>(uniforms), indices.data(),
                          static_cast<u32>(indices.size_bytes()), same_state);
    // Publish the comparison state only after the draw was queued.
    if (program) {
        immediate_state.clear();
    } else if (!same_state) {
        immediate_state.resize(state_size);
        std::size_t offset = 0;
        for (const auto part : state_parts) {
            std::memcpy(immediate_state.data() + offset, part.data(), part.size());
            offset += part.size();
        }
    }
    immediate_state_valid = !program;
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

    if (DrawProgrammable(is_indexed, vertices)) return true;
    pica.LoadVertices(is_indexed, true);
    DrawTriangles();
    return true;
}

bool Rasterizer::DrawProgrammable(bool is_indexed, const VertexArrayInfo& vertex_info) {
    using namespace Pica::Shader::Generator;
    using Topology = Pica::PipelineRegs::TriangleTopology;
    const auto& pipeline = regs.pipeline;
    if (pipeline.use_gs != Pica::PipelineRegs::UseGS::No) return false;
    // Quaternion sign correction matters only when a combiner consumes fragment lighting.
    // Some homebrew leaves the lighting registers enabled while using vertex colors alone.
    if (!regs.lighting.disable) {
        using Source = Pica::TexturingRegs::TevStageConfig::Source;
        for (const auto& stage : regs.texturing.GetTevStages()) {
            for (const auto source : {stage.color_source1.Value(), stage.color_source2.Value(),
                                      stage.color_source3.Value(), stage.alpha_source1.Value(),
                                      stage.alpha_source2.Value(), stage.alpha_source3.Value()}) {
                if (source == Source::PrimaryFragmentColor || source == Source::SecondaryFragmentColor) {
                    return false;
                }
            }
        }
    }
    // Without a geometry program, the shader topology also assembles ordinary triangles.
    const bool triangle_list = pipeline.triangle_topology == Topology::List ||
                               pipeline.triangle_topology == Topology::Shader;
    if (pipeline.num_vertices < 3) return true;
    regs.rasterizer.ValidateSemantics();
    const PicaVSConfig config{regs, pica.vs_setup};
    auto found = vertex_programs.find(config);
    if (found == vertex_programs.end()) {
        ExtraVSConfig extra{};
        extra.use_clip_planes = true;
        extra.separable_shader = true;
        extra.sanitize_mul = true;
        extra.load_flags.fill(AttribLoadFlags::Float);
        VertexProgram program{};
        const auto source = GLSL::GenerateVertexShader(pica.vs_setup, config, extra, true,
                                                       &program.input_mask);
        // Keep a vertex stride even when the program reads no input registers.
        if (!program.input_mask) program.input_mask = 1;
        program.handle = source.empty() ? 0 :
            CreateVertexProgram(("#version 450\n" + source).c_str(), program.input_mask);
        if (vertex_programs.size() >= 512) ClearPrograms();
        found = vertex_programs.emplace(config, program).first;
    }
    const auto& program = found->second;
    if (!program.handle) return false;

    const u32 input_count = std::popcount(program.input_mask);
    std::array<u32, 16> register_attributes;
    register_attributes.fill(16);
    for (u32 attr = 0; attr <= regs.vs.max_input_attribute_index; ++attr) {
        register_attributes[regs.vs.GetRegisterForAttribute(attr)] = attr;
    }
    std::array<u32, 16> packed_attributes{};
    for (u32 mask = program.input_mask, slot = 0; mask; mask &= mask - 1, ++slot) {
        packed_attributes[slot] = register_attributes[std::countr_zero(mask)];
    }
    const auto& attributes = pipeline.vertex_attributes;
    const PAddr base = attributes.GetPhysicalBaseAddress();
    const auto* indices = memory.GetPhysicalPointer(base + pipeline.index_array.offset);
    if (is_indexed && !indices) return true;
    const Pica::VertexLoader loader{memory, pipeline, true};
    constexpr u32 unused_vertex = std::numeric_limits<u32>::max();
    std::vector<u32> vertex_slots;
    if (is_indexed) {
        // Compact only the referenced vertices; sparse 16-bit indices need no empty GPU slots.
        vertex_slots.resize(vertex_info.vs_input_index_max - vertex_info.vs_input_index_min + 1,
                            unused_vertex);
    }
    std::vector<u32> draw_order(is_indexed ? pipeline.num_vertices : 0);
    std::vector<Common::Vec4f> inputs;
    ASSERT(pipeline.num_vertices <= inputs.max_size() / input_count);
    const u32 capacity = is_indexed ? std::min<u32>(pipeline.num_vertices, vertex_slots.size()) :
                                     pipeline.num_vertices;
    inputs.reserve(static_cast<std::size_t>(capacity) * input_count);
    for (u32 index = 0; index < pipeline.num_vertices; ++index) {
        const u32 vertex = is_indexed ? (pipeline.index_array.format ?
            reinterpret_cast<const u16*>(indices)[index] : indices[index]) :
            index + pipeline.vertex_offset;
        if (is_indexed) {
            auto& slot = vertex_slots[vertex - vertex_info.vs_input_index_min];
            if (slot != unused_vertex) {
                draw_order[index] = slot;
                continue;
            }
            slot = static_cast<u32>(inputs.size() / input_count);
            draw_order[index] = slot;
        }
        const auto offset = inputs.size();
        inputs.resize(offset + input_count);
        Pica::AttributeBuffer attributes_in{};
        loader.LoadVertex(base, index, vertex, attributes_in, pica.input_default_attributes);
        for (u32 slot = 0; slot < input_count; ++slot) {
            const u32 attr = packed_attributes[slot];
            if (attr == 16) continue;
            auto& input = inputs[offset + slot];
            for (u32 component = 0; component < 4; ++component) {
                input[component] = attributes_in[attr][component].ToFloat32();
            }
        }
    }
    std::vector<u32> triangles;
    if (!triangle_list) {
        ASSERT(pipeline.num_vertices - 2 <= triangles.max_size() / 3);
        triangles.reserve(static_cast<std::size_t>(pipeline.num_vertices - 2) * 3);
        for (u32 index = 2; index < pipeline.num_vertices; ++index) {
            const bool strip = pipeline.triangle_topology == Topology::Strip;
            const u32 first = strip ? index - 2 + (index & 1) : 0;
            const u32 second = strip ? index - 1 - (index & 1) : index - 1;
            for (const u32 vertex : {first, second, index}) {
                triangles.push_back(is_indexed ? draw_order[vertex] : vertex);
            }
        }
    }
    const auto& elements = triangle_list ? draw_order : triangles;
    VSPicaUniformData uniforms{};
    uniforms.SetFromRegs(pica.vs_setup);
    DrawBatch({reinterpret_cast<const u8*>(inputs.data()), inputs.size() * sizeof(Common::Vec4f)},
              program.handle, &uniforms, elements);
    return true;
}

void Rasterizer::ClearPrograms() {
    for (const auto& [config, program] : vertex_programs) {
        if (program.handle) DestroyVertexProgram(program.handle);
    }
    vertex_programs.clear();
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
void Rasterizer::ClearAll(bool flush) {
    cache.ClearAll(flush);
    vertex_batch.clear();
    ClearPrograms();
    immediate_state.clear();
    immediate_state_valid = false;
}
bool Rasterizer::AccelerateDisplayTransfer(const Pica::DisplayTransferConfig& config) { return cache.AccelerateDisplayTransfer(config); }
bool Rasterizer::AccelerateTextureCopy(const Pica::DisplayTransferConfig& config) { return cache.AccelerateTextureCopy(config); }
bool Rasterizer::AccelerateFill(const Pica::MemoryFillConfig& config) { return cache.AccelerateFill(config); }
void Rasterizer::TickFrame() { cache.TickFrame(); }

} // namespace WebGPU
