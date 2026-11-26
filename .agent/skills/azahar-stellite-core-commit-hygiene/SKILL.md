---
name: azahar-stellite-core-commit-hygiene
description: Inspect and protect Git boundaries before branch, staging, commit, history rewrite, push, merge from upstream, submodule pin, or PR work in azahar-stellite-core, Stellite's fork of the Azahar 3DS emulator. Use for reviewing dirty trees, keeping fork work apart from upstream history, recording external fork pins, or preparing any Git mutation. Commit completed changes frequently under standing authorization. Pushing, rewriting history and changing branches need separate authorization.
---

# Keep azahar-stellite-core history clean

Load this skill before any Git mutation beyond read-only inspection.

## Inspect first

Run in the azahar-stellite-core Git root (`azahar-stellite-core/`):

```sh
git status --short --branch
git remote -v
git diff --stat
git diff --cached --stat
git diff --cached
git submodule status
```

Classify pre-existing work and current-task changes. Never stage unrelated files, discard another session's work, reset another process's changes, or bypass hooks.

Split mixed dirty trees. One commit is one change: the core, the Wasm JIT, audio, the Qt frontend, the web layer and a submodule pin each go alone.

## Commit authorization and cadence

Commit your own completed feature or fix slices frequently after their relevant checks pass, as `AGENTS.md` describes: Azahar's own native tests and the pinned dependencies' fixtures, ported to Wasm where the change runs there, on the Lima or devbox build paths it names. This is standing authorization from the owner: do not ask before routine commits and do not defer all commits to the end of a long task.

Commit only your own changes. Authorization to commit never authorizes pushing, creating or switching branches, amending, or rewriting history. Each needs separate authorization unless the session already provides it.

## Remotes and branches

| Remote | Address | Use |
| --- | --- | --- |
| `origin` | `https://browserports.dev/BrowserPorts/azahar-stellite-core.git` | Forgejo, the fork. The only push target. |
| `upstream` | `https://github.com/azahar-emu/azahar.git` | Azahar itself. Fetch only. |

- `main` is the fork's branch and carries the Wasm core, the Qt-free core archive and the browser frontend on top of `upstream/master`.
- `origin/master` is an older point of the fork's own work, not a copy of upstream. Leave it alone; read upstream through `upstream/master`.
- Never push to `upstream`, and never open a pull request or issue against `azahar-emu/azahar` from here. Upstream's `AI-POLICY.md` governs submissions to that project.
- Bring upstream in with a merge of `upstream/master` into `main`, as its own commit with nothing else in it. Do not rebase `main`: Stellite builds pin its commits.
- Upstream's own commits come in through the merge exactly as they are, whatever their messages carry. Never rewrite them and never strip lines from them.
- Keep fork edits to upstream files small so merges stay cheap.
- This repository is public. Forgejo pushes it to the read-only mirror at `github.com/BrowserPorts/azahar-stellite-core`. Reach GitHub only through that mirror: never push to GitHub directly.

## Submodules

Every fork submodule lives on Forgejo under `BrowserPorts`, and `.gitmodules` fetches each from there:

| Path | Forgejo repository | Where it is changed |
| --- | --- | --- |
| `externals/dynarmic` | `dynarmic-stellite-wasm` | `../dynarmic-stellite-wasm` |
| `externals/libressl` | `libressl-stellite-wasm` | `../libressl-stellite-wasm` |
| `externals/teakra` | `teakra-stellite-wasm` | its `externals/` checkout |
| `externals/dds-ktx` | `dds-ktx-stellite` | its `externals/` checkout |
| `externals/wgpu` (named `naga`) | `wgpu-stellite-web` | its `externals/` checkout |
| `externals/emscripten` | `emscripten-stellite-wasm` | its `externals/` checkout |
| `externals/qtbase` | `qtbase-stellite-wasm` | its `externals/` checkout |
| `externals/qtmultimedia` | `qtmultimedia-stellite-wasm` | its `externals/` checkout |

- Never commit or push from `externals/dynarmic` or `externals/libressl`; their standalone checkouts are the Git roots for that work.
- The other six are worked on in place. Each carries its own `<name>-commit-hygiene` skill under `.agent/skills/`; load it before any Git mutation there.
- A change reaches azahar in two steps: commit and push it to Forgejo `origin` in the fork first, then commit the new gitlink here on its own, with nothing else in the commit.
- Never record a dirty submodule or a commit its Forgejo remote does not have. Fetch in the submodule and confirm `git branch -r --contains HEAD` lists `origin/main` first.
- Third-party pins change only on purpose.

## Staging

Inspect every untracked path. Never stage:

- `build/` and any `[Bb]uild*/`, `build-*/`, `cmake-build-*/`, `.ccache/`, `.cache/`, `node_modules/`, `verify/`
- the standalone web player, its assets and the agent players under `build/`; `AGENTS.md` keeps them local
- `src/common/scm_rev.cpp`, `GIT-COMMIT`, `GIT-TAG`, `CMakeUserPresets.json`, `VULKAN_SDK/`
- game ROMs, CIAs, keys, saves, NAND or SDMC images, firmware, shader caches, recordings and traces

The pre-commit hook enforces Citra's whitespace policy on `src/` and `CMakeLists.txt`: no trailing spaces and no tabs. Fix what it reports; never skip it.

Stage exact paths, then rerun status and inspect the complete staged diff. Unstage a prohibited path with `git restore --staged -- <path>`; do not discard its working copy.

## Commit messages

Use Conventional Commits. Upstream writes its subjects as `area: summary` without a type, so a typed subject also marks a commit as the fork's:

```text
<type>(<scope>): <imperative technical summary>
```

- Keep the subject at or below 72 characters.
- Describe product behavior and technical rationale only.
- Use the configured human author and committer.
- No AI or model attribution of any kind: no `Co-Authored-By` naming Claude or Anthropic, no `noreply@anthropic.com`, no `Claude-Session` line, no generated-by line. Nothing on the server checks this, so the agent making the commit is responsible for keeping it out of every fork commit.
- No sessions, prompts, task or rule numbers, agents, waves, worktrees, workflows, checkpoints, plans, transcripts, or process narration.

Scan the exact proposed message before committing:

```sh
rg -ni 'co-authored-by:.*(claude|anthropic|ai)|claude-session|assisted-by|generated(-by| with)|task ?#|rule ?#|#[0-9]|iter-|wave|refuter|worktree|workflow|goal-mode|checkpoint|transcript'
```

No matches are permitted.

## Pushing

- Push only to `origin` on Forgejo, and only when authorized. `git remote get-url --push origin` must print the Forgejo URL. Never push to Cursor's origin (`origin.cursor.com`), to `upstream`, or to GitHub.
- Push one branch with an explicit refspec: `git push origin main:main`. Never `--force`, `--all`, `--mirror`, or a bare `git push`.
- Before every push, scan the whole outgoing range, including commits already ahead of the remote and those an upstream merge brings, and stop if anything matches:

```sh
git log --format='%H%n%B' origin/main..HEAD | rg -ni 'co-authored-by:.*(claude|anthropic)|noreply@anthropic\.com|claude-session|generated(-by| with)'
```

- Stop on any match and look at it. A match in a fork commit is fixed before the push. A match in upstream's own commit, one an upstream merge brought in (`git merge-base --is-ancestor <hash> upstream/master` succeeds), goes out exactly as it is: never rewrite it and never strip lines from it.
- If Forgejo refuses a push, report why. Do not rewrite history to get around it.

## Safeguards

- Never use `--no-verify`.
- Never amend a pushed commit, force-push, or rewrite shared history without explicit approval.
- Use `codex/<topic>` only when a branch is requested.
- Reinspect `git show --stat --oneline --decorate HEAD` and status after every commit.
