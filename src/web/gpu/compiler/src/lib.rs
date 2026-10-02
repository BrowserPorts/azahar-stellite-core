// SPDX-License-Identifier: GPL-2.0-or-later

use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::ShaderStage;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[link(wasm_import_module = "azahar")]
extern "C" {
    fn shader_panic(pointer: *const u8, length: usize);
}

pub struct Compiler {
    frontend: Frontend,
    output: Vec<u8>,
}

impl Compiler {
    fn translate(&mut self, source: &str, stage: u32) -> Result<String, String> {
        let stage = match stage {
            0 => ShaderStage::Vertex,
            1 => ShaderStage::Fragment,
            2 => ShaderStage::Compute,
            _ => return Err("Invalid shader stage".into()),
        };
        let module = self
            .frontend
            .parse(&Options::from(stage), source)
            .map_err(|error| error.emit_to_string(source))?;
        Self::write_wgsl(module, Some(source))
    }

    fn translate_spirv(&mut self, bytes: &[u8]) -> Result<String, String> {
        let options = naga::front::spv::Options {
            adjust_coordinate_space: false,
            ..Default::default()
        };
        let module =
            naga::front::spv::parse_u8_slice(bytes, &options).map_err(|error| error.to_string())?;
        Self::write_wgsl(module, None)
    }

    fn write_wgsl(mut module: naga::Module, source: Option<&str>) -> Result<String, String> {
        let diagnostic = |error: naga::WithSpan<naga::valid::ValidationError>| match source {
            Some(source) => error.emit_to_string(source),
            None => format!("{error:?}"),
        };
        let mut validator = Validator::new(
            ValidationFlags::all(),
            Capabilities::default() | Capabilities::CLIP_DISTANCES,
        );
        validator.validate(&module).map_err(diagnostic)?;
        naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
        let info = validator.validate(&module).map_err(diagnostic)?;
        let wgsl =
            naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
                .map_err(|error| error.to_string())?;
        // Validate the emitted language as well as the compiler's intermediate form.
        let output =
            naga::front::wgsl::parse_str(&wgsl).map_err(|error| error.emit_to_string(&wgsl))?;
        validator
            .validate(&output)
            .map_err(|error| error.emit_to_string(&wgsl))?;
        Ok(wgsl)
    }

    fn store(&mut self, result: Result<String, String>) -> u32 {
        match result {
            Ok(output) => {
                self.output = output.into_bytes();
                1
            }
            Err(error) => {
                self.output = error.into_bytes();
                0
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn azahar_shader_abi() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn azahar_shader_create() -> *mut Compiler {
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        unsafe { shader_panic(message.as_ptr(), message.len()) };
    }));
    Box::into_raw(Box::new(Compiler {
        frontend: Frontend::default(),
        output: Vec::new(),
    }))
}

/// # Safety
/// The handle must have been returned by azahar_shader_create and remain live.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_destroy(compiler: *mut Compiler) {
    drop(unsafe { Box::from_raw(compiler) });
}

#[no_mangle]
pub extern "C" fn azahar_shader_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

/// # Safety
/// The pointer and length must match a live azahar_shader_alloc allocation.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_free(pointer: *mut u8, length: usize) {
    let bytes = std::ptr::slice_from_raw_parts_mut(pointer, length);
    drop(unsafe { Box::from_raw(bytes) });
}

/// Returns one for WGSL output, zero for a diagnostic in the output buffer.
/// # Safety
/// Input bytes and the compiler handle must remain live for the call.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_compile(
    compiler: *mut Compiler,
    pointer: *const u8,
    length: usize,
    stage: u32,
) -> u32 {
    let compiler = unsafe { &mut *compiler };
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
    let result = std::str::from_utf8(bytes)
        .map_err(|error| error.to_string())
        .and_then(|source| compiler.translate(source, stage));
    compiler.store(result)
}

/// Returns one for WGSL output, zero for a diagnostic in the output buffer.
/// # Safety
/// Input bytes and the compiler handle must remain live for the call.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_compile_spirv(
    compiler: *mut Compiler,
    pointer: *const u8,
    length: usize,
) -> u32 {
    let compiler = unsafe { &mut *compiler };
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
    let result = compiler.translate_spirv(bytes);
    compiler.store(result)
}

/// Output lives until the next compile call or destruction of this handle.
/// # Safety
/// The handle must refer to a live compiler.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_output(compiler: *const Compiler) -> *const u8 {
    unsafe { &*compiler }.output.as_ptr()
}

/// # Safety
/// The handle must refer to a live compiler.
#[no_mangle]
pub unsafe extern "C" fn azahar_shader_output_length(compiler: *const Compiler) -> usize {
    unsafe { &*compiler }.output.len()
}
