// SPDX-License-Identifier: GPL-2.0-or-later

#include <catch2/interfaces/catch_interfaces_config.hpp>
#include <catch2/reporters/catch_reporter_event_listener.hpp>
#include <catch2/reporters/catch_reporter_registrars.hpp>
#include "rand_int.h"

namespace {
class FuzzRuntime final : public Catch::EventListenerBase {
public:
    using Catch::EventListenerBase::EventListenerBase;

    void testRunStarting(const Catch::TestRunInfo&) override {
        detail::g_rand_int_generator.seed(m_config->rngSeed());
    }
};
}

CATCH_REGISTER_LISTENER(FuzzRuntime)
