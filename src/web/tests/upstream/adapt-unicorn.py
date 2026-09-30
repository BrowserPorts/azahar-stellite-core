# SPDX-License-Identifier: GPL-2.0-or-later

from pathlib import Path
import sys


tests = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)


def replace_once(text, original, adapted):
    if text.count(original) != 1:
        raise RuntimeError(f"The native Unicorn harness changed: {original}")
    return text.replace(original, adapted)


def write(name, text):
    destination = output / name
    if not destination.exists() or destination.read_text() != text:
        destination.write_text(text)


header = (tests / "unicorn_emu/a32_unicorn.h").read_text()
header = replace_once(header, '#include "../A32/testenv.h"', f'#include "{tests}/A32/testenv.h"')
header = replace_once(
    header,
    "static bool UnmappedMemoryHook(uc_engine* uc, uc_mem_type type, u32 addr, int size, u64 value, void* user_data);",
    "static bool UnmappedMemoryHook(uc_engine* uc, uc_mem_type type, u64 addr, int size, s64 value, void* user_data);",
)
header = replace_once(
    header,
    "static bool MemoryWriteHook(uc_engine* uc, uc_mem_type type, u32 addr, int size, u64 value, void* user_data);",
    "static void MemoryWriteHook(uc_engine* uc, uc_mem_type type, u64 addr, int size, s64 value, void* user_data);",
)
write("a32_unicorn.h", header)

wrapper = (tests / "unicorn_emu/a32_unicorn.cpp").read_text()
wrapper = replace_once(wrapper, '#include "../A32/testenv.h"', f'#include "{tests}/A32/testenv.h"')
for name, result, value in [("UnmappedMemoryHook", "bool", "/*value*/"), ("MemoryWriteHook", "void", "value")]:
    original = f"bool A32Unicorn<TestEnvironment>::{name}(uc_engine* "
    original += "uc" if name == "UnmappedMemoryHook" else "/*uc*/"
    original += f", uc_mem_type /*type*/, u32 start_address, int size, u64 {value}, void* user_data) {{"
    adapted = original.replace("bool A32Unicorn", f"{result} A32Unicorn").replace(
        "u32 start_address", "u64 address"
    ).replace(f"u64 {value}", f"s64 {value}")
    adapted += "\n    const u32 start_address = static_cast<u32>(address);"
    wrapper = replace_once(wrapper, original, adapted)
wrapper = replace_once(
    wrapper,
    "    return true;\n}\n\ntemplate class A32Unicorn<ArmTestEnv>;",
    "    return;\n}\n\ntemplate class A32Unicorn<ArmTestEnv>;",
)
wrapper = replace_once(
    wrapper,
    "    CHECKED(uc_open(UC_ARCH_ARM, open_mode, &uc));",
    "    static_assert(std::is_same_v<decltype(&UnmappedMemoryHook), uc_cb_eventmem_t>);\n"
    "    static_assert(std::is_same_v<decltype(&MemoryWriteHook), uc_cb_hookmem_t>);\n\n"
    "    CHECKED(uc_open(UC_ARCH_ARM, open_mode, &uc));",
)
write("a32_unicorn.cpp", wrapper)

# Only the harness include changes; every test input and assertion stays intact.
for name in ["fuzz_arm.cpp", "fuzz_thumb.cpp"]:
    original = (tests / "A32" / name).read_text()
    adapted = replace_once(
        original, '#include "../unicorn_emu/a32_unicorn.h"', '#include "a32_unicorn.h"'
    )
    # Other relative includes still point to the pinned native test directory.
    adapted = adapted.replace('#include "../', f'#include "{tests}/')
    adapted = adapted.replace('#include "./testenv.h"', f'#include "{tests}/A32/testenv.h"')
    write(name, adapted)
