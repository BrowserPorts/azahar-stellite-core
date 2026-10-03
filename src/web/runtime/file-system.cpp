// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <fcntl.h>
#include <memory>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <cryptopp/sha.h>
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include "backend.h"
#include "memory_backend.h"
#include "wasmfs.h"

extern "C" ssize_t azahar_read_browser_file(std::uint8_t* bytes, size_t length, off_t offset);

namespace {

class BrowserFile final : public wasmfs::DataFile {
public:
    BrowserFile(mode_t mode, wasmfs::backend_t backend, off_t size_)
        : DataFile{mode, backend}, size{size_} {}

private:
    int open(wasmfs::oflags_t flags) override { return (flags & O_ACCMODE) == O_RDONLY ? 0 : -EROFS; }
    int close() override { return 0; }
    int flush() override { return 0; }
    off_t getSize() override { return size; }
    int setSize(off_t) override { return -EROFS; }
    ssize_t write(const std::uint8_t*, size_t, off_t) override { return -EROFS; }
    ssize_t read(std::uint8_t* bytes, size_t length, off_t offset) override {
        return azahar_read_browser_file(bytes, length, offset);
    }
    const off_t size;
};

class BrowserFileBackend final : public wasmfs::Backend {
public:
    explicit BrowserFileBackend(off_t size_) : size{size_} {}
    std::shared_ptr<wasmfs::DataFile> createFile(mode_t mode) override {
        return std::make_shared<BrowserFile>(mode, this, size);
    }
    std::shared_ptr<wasmfs::Directory> createDirectory(mode_t mode) override {
        return std::make_shared<wasmfs::MemoryDirectory>(mode, this);
    }
    std::shared_ptr<wasmfs::Symlink> createSymlink(std::string target) override {
        return std::make_shared<wasmfs::MemorySymlink>(std::move(target), this);
    }

private:
    const off_t size;
};

bool MakeDirectory(const char* path) {
    if (mkdir(path, 0777) == 0) return true;
    if (errno != EEXIST) return false;
    struct stat info{};
    return stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_mount_storage() {
    const auto backend = wasmfs_create_opfs_backend();
    if (wasmfs_create_directory("/opfs", 0777, backend) != 0 ||
        !MakeDirectory("/opfs/azahar") || !MakeDirectory("/opfs/azahar/user") ||
        symlink("/opfs/azahar/user", "/user") != 0 || !MakeDirectory("/rom")) {
        return false;
    }
    return true;
}

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_mount_game_file(const char* path, std::uint64_t size) {
    if (!path || !size || size > INT64_MAX) return false;
    const auto backend = wasmfs::wasmFS.addBackend(
        std::make_unique<BrowserFileBackend>(static_cast<off_t>(size)));
    const int fd = wasmfs_create_file(path, 0444, reinterpret_cast<backend_t>(backend));
    return fd >= 0 && close(fd) == 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_unmount_game_file(const char* path) {
    return path && unlink(path) == 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* azahar_content_id(const char* path) {
    if (!path) return nullptr;
    static std::array<char, 65> text{};
    FILE* file = std::fopen(path, "rb");
    if (!file) return nullptr;
    CryptoPP::SHA256 hash;
    std::array<std::uint8_t, 65536> bytes;
    while (const auto read = std::fread(bytes.data(), 1, bytes.size(), file)) {
        hash.Update(bytes.data(), read);
    }
    const bool failed = std::ferror(file);
    const int closed = std::fclose(file);
    if (failed || closed != 0) return nullptr;
    std::array<std::uint8_t, CryptoPP::SHA256::DIGESTSIZE> digest;
    hash.Final(digest.data());
    constexpr char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < digest.size(); i++) {
        text[i * 2] = hex[digest[i] >> 4];
        text[i * 2 + 1] = hex[digest[i] & 15];
    }
    return text.data();
}
