// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <cryptopp/sha.h>
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include "backend.h"
#include "common/file_util.h"
#include "memory_backend.h"
#include "wasmfs.h"

extern "C" ssize_t azahar_read_browser_file(std::uint8_t* bytes, size_t length, off_t offset);
extern "C" ssize_t azahar_read_import_file(std::uint8_t* bytes, size_t length, off_t offset);

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

bool CopyImportFile(int fd, std::uint64_t size) {
    std::array<std::uint8_t, 65536> bytes;
    std::uint64_t offset = 0;
    while (offset < size) {
        const auto length = std::min<std::uint64_t>(bytes.size(), size - offset);
        const auto read = azahar_read_import_file(bytes.data(), length, offset);
        if (read <= 0 || static_cast<std::uint64_t>(read) > length) return false;
        ssize_t written = 0;
        while (written < read) {
            const auto result = write(fd, bytes.data() + written, read - written);
            if (result < 0 && errno == EINTR) continue;
            if (result <= 0) return false;
            written += result;
        }
        offset += read;
    }
    return fsync(fd) == 0;
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

extern "C" EMSCRIPTEN_KEEPALIVE bool azahar_import_user_file(const char* path, std::uint64_t size) {
    if (!path || size > 9007199254740991ULL) return false;
    const auto length = strnlen(path, 4096);
    if (!length || length == 4096) return false;
    const std::string relative{path, length};
    if (relative.find('\\') != std::string::npos) return false;
    size_t start = 0;
    do {
        const auto end = relative.find('/', start);
        const auto part = relative.substr(start, end - start);
        if (part.empty() || part == "." || part == "..") return false;
        if (end == std::string::npos) break;
        start = end + 1;
    } while (true);

    auto* root = realpath(FileUtil::GetUserPath(FileUtil::UserPath::UserDir).c_str(), nullptr);
    if (!root) return false;
    const std::string directory_root{root};
    std::free(root);
    if (directory_root != "/opfs/azahar/user" &&
        !directory_root.starts_with("/opfs/azahar/user/")) return false;
    const std::string destination = directory_root + "/" + relative;
    for (size_t end = destination.find('/', 1); end != std::string::npos;
         end = destination.find('/', end + 1)) {
        const auto directory = destination.substr(0, end);
        if (mkdir(directory.c_str(), 0777) != 0 && errno != EEXIST) return false;
        struct stat info{};
        if (lstat(directory.c_str(), &info) != 0 || !S_ISDIR(info.st_mode)) return false;
    }
    auto temporary = destination + ".tmp.XXXXXX";
    const int fd = mkstemp(temporary.data());
    if (fd < 0) return false;
    const bool copied = CopyImportFile(fd, size);
    const int closed = close(fd);
    if (copied && closed == 0 && rename(temporary.c_str(), destination.c_str()) == 0) return true;
    unlink(temporary.c_str());
    return false;
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
