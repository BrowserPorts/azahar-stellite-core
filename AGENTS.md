# Repository instructions

- The standalone web player is for agent use only. Keep its source and assets in ignored local build directories; do not commit them or add them to shared build or package targets.
- Preserve the independent Stellite core build when porting the upstream Qt frontend. The standard web build must continue to produce the core archive and runtime without requiring Qt; frontend validation uses a separate build configuration.
- Do not write new smoke tests or unit tests
- For validation, port and run Azahar's existing native tests, including the native fixtures in its pinned dependencies
- Preserve upstream test cases and expected results when adapting their build or execution harness for Wasm
- Commit completed feature or fix slices frequently after their relevant checks pass, following the commit-hygiene skill
- Keep each commit focused on one change; do not defer completed changes until the end of a long task
- Pushes, branch changes, publishing, and history rewrites need separate authorization
- Linux builds use exactly two paths.
  - Lima: a local Lima VM whose instance directory (`LIMA_HOME`), VM disks, and build output all live on `/Volumes/Ferrochrome`. If that volume is not mounted, stop and report the missing dependency and the rerun command; do not fall back to the internal system volume.
  - Devbox: the persistent Namespace box `webart-art`, through the `shared-devbox` skill. Every devbox build needs the user's authorization for that specific build. Ask before each one, and do not reuse an earlier approval for a later build.
