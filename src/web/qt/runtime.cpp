// SPDX-License-Identifier: GPL-2.0-or-later

#include <atomic>
#include <thread>
#include <emscripten.h>
#include "common/file_util.h"
#include "web/qt/runtime.h"

extern "C" bool azahar_mount_storage();

namespace {

using emscripten::EM_VAL;

EM_ASYNC_JS(bool, InitializeBrowserFrontend, (), {
    try {
        const runtime = await import(new URL(locateFile("azahar-qt-runtime.js"), location.href).href);
        await runtime.initializeFrontend();
        Module["azaharQtRuntime"] = runtime;
        return true;
    } catch (error) {
        err(String(error));
        return false;
    }
});

EM_JS(void, ReleaseBrowserFrontend, (), {
    Module["azaharQtRuntime"]?.shutdownFrontend();
});

EM_JS(void, RegisterBrowserSurface, (EM_VAL surface), {
    Module["azaharQtCanvas"] = Emval.toValue(surface);
});

EM_JS(void, UnregisterBrowserSurface, (EM_VAL surface), {
    if (Module["azaharQtCanvas"] === Emval.toValue(surface)) {
        delete Module["azaharQtCanvas"];
    }
});

EM_ASYNC_JS(int, WaitForStorage, (const void* result), {
    const index = result >>> 2;
    while (Atomics.load(HEAP32, index) === 0) {
        await Atomics.waitAsync(HEAP32, index, 0).value;
    }
    return Atomics.load(HEAP32, index);
});

EM_JS(void, NotifyStorageReady, (const void* result), {
    Atomics.notify(HEAP32, result >>> 2);
});

} // namespace

namespace Web::Qt {

bool InitializeFrontend() {
    if (!InitializeBrowserFrontend()) {
        return false;
    }
    std::atomic<int> result{0};
    static_assert(sizeof(result) == 4 && std::atomic<int>::is_always_lock_free);
    std::thread mounting([&result] {
        result.store(azahar_mount_storage() ? 1 : -1, std::memory_order_release);
        NotifyStorageReady(&result);
    });
    const bool mounted = WaitForStorage(&result) == 1;
    mounting.join();
    if (!mounted) {
        ReleaseBrowserFrontend();
        return false;
    }
    FileUtil::SetUserPath("/user/");
    return true;
}

void ShutdownFrontend() {
    ReleaseBrowserFrontend();
}

void RegisterRenderSurface(const emscripten::val& canvas) {
    RegisterBrowserSurface(canvas.as_handle());
}

void UnregisterRenderSurface(const emscripten::val& canvas) {
    UnregisterBrowserSurface(canvas.as_handle());
}

} // namespace Web::Qt
