// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <pthread.h>
#include <stdlib.h>

static pthread_mutex_t arc4random_mtx = PTHREAD_MUTEX_INITIALIZER;
#define _ARC4_LOCK() pthread_mutex_lock(&arc4random_mtx)
#define _ARC4_UNLOCK() pthread_mutex_unlock(&arc4random_mtx)

static inline void _getentropy_fail(void) {
    abort();
}

static inline void _rs_forkdetect(void) {
    // Wasm workers share this state under the mutex; the browser cannot fork.
}

static inline int _rs_allocate(struct _rs** state, struct _rsx** stream) {
    *state = calloc(1, sizeof(**state));
    if (!*state) {
        return -1;
    }
    *stream = calloc(1, sizeof(**stream));
    if (!*stream) {
        free(*state);
        *state = NULL;
        return -1;
    }
    return 0;
}
