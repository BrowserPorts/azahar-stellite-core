// SPDX-License-Identifier: GPL-2.0-or-later

#include <atomic>
#include <cstdlib>
#include <thread>
#include <emscripten.h>
#include <pthread.h>
#include "audio_core/audio_types.h"
#include "common/file_util.h"
#include "web/qt/runtime.h"

extern "C" bool azahar_mount_storage();

EM_JS_DEPS(qt_emulation, "azahar_qt_request_surface,azahar_qt_release_audio,$stringToNewUTF8");

namespace {

using emscripten::EM_VAL;

EM_ASYNC_JS(bool, InitializeBrowserFrontend, (unsigned sample_rate), {
    try {
        const runtime = await import(new URL(locateFile("azahar-qt-runtime.js"), location.href).href);
        await runtime.initializeFrontend(sample_rate);
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

EM_JS(void, SetBrowserAudioRunning, (bool running), {
    Module["azaharQtRuntime"]?.setAudioRunning(Boolean(running));
});

EM_JS(void, RegisterBrowserSurface, (EM_VAL surface), {
    Module["azaharQtCanvas"] = Emval.toValue(surface);
});

EM_JS(void, UnregisterBrowserSurface, (EM_VAL surface), {
    if (Module["azaharQtCanvas"] === Emval.toValue(surface)) {
        delete Module["azaharQtCanvas"];
    }
});

EM_ASYNC_JS(bool, InitializeBrowserEmulation, (unsigned thread), {
    try {
        Module["azaharQtEmulationError"] = "";
        const surface = new Promise((resolve, reject) => {
            const receive = (event) => {
                if (event.data.azaharQtSurface instanceof OffscreenCanvas) {
                    self.removeEventListener("message", receive);
                    resolve(event.data.azaharQtSurface);
                } else if (typeof event.data.azaharQtSurfaceError === "string") {
                    self.removeEventListener("message", receive);
                    reject(new Error(event.data.azaharQtSurfaceError));
                }
            };
            self.addEventListener("message", receive);
            try {
                if (!_azahar_qt_request_surface(thread)) {
                    throw new Error("Qt emulation worker is unavailable");
                }
            } catch (error) {
                self.removeEventListener("message", receive);
                reject(error);
            }
        });
        const [canvas, runtime] = await Promise.all([
            surface,
            import(new URL(locateFile("azahar-qt-emulation.js"), location.href).href)
        ]);
        await runtime.initializeEmulation(Module, canvas);
        Module["azaharQtEmulation"] = runtime;
        return true;
    } catch (error) {
        Module["azaharQtEmulationError"] = String(error);
        err(String(error));
        return false;
    }
});

EM_ASYNC_JS(bool, YieldBrowserEmulation, (), {
    try {
        await Module["azaharQtEmulation"].yieldEmulation();
        return true;
    } catch (error) {
        Module["azaharQtEmulationError"] = String(error);
        err(String(error));
        return false;
    }
});

EM_ASYNC_JS(void, ShutdownBrowserEmulation, (unsigned thread), {
    try {
        await Module["azaharQtEmulation"]?.shutdownEmulation();
    } catch (error) {
        err(String(error));
    } finally {
        delete Module["azaharQtEmulation"];
        _azahar_qt_release_audio(thread);
    }
});

EM_JS(char*, CopyBrowserEmulationError, (), {
    return stringToNewUTF8(Module["azaharQtEmulationError"] || "Browser emulation failed");
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
    if (!InitializeBrowserFrontend(AudioCore::native_sample_rate)) {
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

void SetAudioRunning(bool running) {
    SetBrowserAudioRunning(running);
}

void RegisterRenderSurface(const emscripten::val& canvas) {
    RegisterBrowserSurface(canvas.as_handle());
}

void UnregisterRenderSurface(const emscripten::val& canvas) {
    UnregisterBrowserSurface(canvas.as_handle());
}

bool InitializeEmulation() {
    return InitializeBrowserEmulation(static_cast<unsigned>(pthread_self()));
}

bool YieldEmulation() {
    return YieldBrowserEmulation();
}

void ShutdownEmulation() {
    ShutdownBrowserEmulation(static_cast<unsigned>(pthread_self()));
}

std::string EmulationError() {
    char* message = CopyBrowserEmulationError();
    std::string result{message};
    std::free(message);
    return result;
}

} // namespace Web::Qt
