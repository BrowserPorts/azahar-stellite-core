// SPDX-License-Identifier: GPL-2.0-or-later

#include <atomic>
#include "dynarmic/common/spin_lock.h"

namespace Dynarmic {
void SpinLock::Lock() {
    std::atomic_ref<int> value{const_cast<int&>(storage)};
    while (value.exchange(1, std::memory_order_acquire)) {}
}

void SpinLock::Unlock() {
    std::atomic_ref<int>{const_cast<int&>(storage)}.store(0, std::memory_order_release);
}
} // namespace Dynarmic
