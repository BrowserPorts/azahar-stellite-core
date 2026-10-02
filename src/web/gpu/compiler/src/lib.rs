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
        let mut module = self
            .frontend
            .parse(&Options::from(stage), source)
            .map_err(|error| error.emit_to_string(source))?;
        let mut validator = Validator::new(ValidationFlags::all(), Capabilities::default());
        validator
            .validate(&module)
            .map_err(|error| error.emit_to_string(source))?;
        naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
        let info = validator
            .validate(&module)
            .map_err(|error| error.emit_to_string(source))?;
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
    match result {
        Ok(output) => {
            compiler.output = output.into_bytes();
            1
        }
        Err(error) => {
            compiler.output = error.into_bytes();
            0
        }
    }
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
