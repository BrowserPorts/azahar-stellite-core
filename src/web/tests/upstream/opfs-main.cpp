// SPDX-License-Identifier: GPL-2.0-or-later

#ifdef main
#undef main
#endif

#include <cassert>
#include <cerrno>
#include <sys/stat.h>
#include <unistd.h>
#include <emscripten/wasmfs.h>

int upstream_main();

int main() {
    const auto backend = wasmfs_create_opfs_backend();
    assert(wasmfs_create_directory("/opfs", 0777, backend) == 0);
    const char* directory = "/opfs/azahar-native-unlink";
    assert(mkdir(directory, 0777) == 0 || errno == EEXIST);
    assert(chdir(directory) == 0);
    // Remove artifacts from an interrupted run of the same upstream fixture.
    unlink("test.dat");
    rmdir("test.dir");
    const int result = upstream_main();
    assert(chdir("/opfs") == 0);
    assert(rmdir(directory) == 0);
    return result;
}
