# Contributing to jterm

Thanks for taking the time. jterm is small on purpose, so it's an easy codebase
to get into; the whole thing is a few thousand lines split between a Rust
backend and a React/TypeScript frontend.

## Getting set up

You'll need Node 20+, [pnpm](https://pnpm.io), and a stable
[Rust](https://rustup.rs) toolchain, plus your platform's build tools (Xcode CLT
on macOS; MSVC Build Tools + WebView2 on Windows).

```sh
pnpm install
pnpm tauri dev
```

That builds the Rust backend, starts Vite, and opens the app with hot reload.
Frontend changes reload instantly; Rust changes trigger a recompile.

## Project layout

- `src-tauri/`: the Rust backend.
  - `src/pty.rs`: `PtyManager`. Spawning shells, the per-PTY reader thread,
    write/resize/kill, and cwd lookup.
  - `src/lib.rs`: every Tauri command (PTY, file I/O, search, Git) and the app
    builder that registers them.
- `src/`: the React/TypeScript frontend.
  - `state/`: the pane-tree data model (`types.ts`), pure tree operations
    (`tree.ts`), the store (`store.tsx`), and the editor/settings reducers.
  - `terminal/`: the xterm + PTY manager that lives outside React, and the
    theme.
  - `components/`: the UI.
  - `workspace.ts`: path and cwd helpers.
  - `App.tsx`: layout, keyboard shortcuts, and the wiring between the manager
    and the store.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how these fit together
and the data flow between them. Read it before a non-trivial change.

## Invariants worth respecting

A few things in this codebase are load-bearing. Breaking them tends to cause
subtle bugs:

1. **Terminals live outside React.** xterm instances and their PTYs are owned by
   `terminal/manager.ts`, keyed by pane id. React only attaches/detaches their
   DOM elements. Don't move terminal state into React state; that's what keeps a
   shell and its scrollback alive across splits and tab switches.
2. **Tree operations are pure.** Everything in `state/tree.ts` returns a new tree
   and never mutates. The reducer depends on that for predictable re-renders.
3. **Don't truncate files.** The editor and search both refuse binaries and
   oversized files rather than reading a partial buffer. Keep that; silently
   truncating then saving would destroy data.
4. **Search must stay cancellable.** Each query bumps a generation counter and
   in-flight scans bail when superseded. If you touch search, keep it off the UI
   thread and keep it cancelling.

## Adding a backend command

Tauri commands are the bridge between the UI and the OS. To add one:

1. Write the function in `src-tauri/src/lib.rs` (or a module) with
   `#[tauri::command]`. Return `Result<T, String>` so errors surface in the UI.
2. Register it in the `tauri::generate_handler![…]` list in `run()`.
3. If it needs a capability that isn't already granted (a new plugin permission),
   add it to `src-tauri/capabilities/default.json`.
4. Call it from the frontend with `invoke("your_command", { …args })`. Argument
   names are camelCase on the JS side and snake_case in Rust; Tauri maps them.

## Style

- **Rust**: run `cargo fmt` before committing. CI checks formatting and runs
  `cargo clippy`. Prefer returning `Result` over `unwrap()` in command paths.
- **TypeScript**: 2-space indent and the existing import ordering. `tsc` runs in
  strict mode with `noUnusedLocals`/`noUnusedParameters`, so dead code fails the
  build.
- **Comments**: keep the code self-documenting and free of inline comments.
  Doc-comments are the exception — a `/** … */` (TypeScript) or `///` / `//!`
  (Rust) directly above a function, type, or module is welcome to describe its
  contract. Anything that needs more explanation than a clear name and a
  doc-comment belongs in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), not in a
  `//` comment.

## Tests

```sh
pnpm test:run                                     # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # backend
```

The suite focuses on pure logic: tree manipulation, the editor reducer, settings
parsing, and the Rust search/Git-status helpers. If you change any of those,
update or add a test. UI components aren't unit-tested yet; manual verification
in `pnpm tauri dev` is expected for UI changes; describe what you checked in the
PR.

## Pull requests

- Branch off `main`, keep the change focused, and write a clear description of
  what and why.
- Make sure `pnpm test:run`, `cargo test`, `pnpm build`, and `cargo fmt --check`
  all pass; that's exactly what CI runs.
- Note anything you verified by hand (which OS, which flows).
- Add a `CHANGELOG.md` entry under **Unreleased** for anything user-facing.

## Releasing (maintainers)

1. Update `version` in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`, and move the `CHANGELOG.md` Unreleased section
   under a new version heading.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow builds the macOS and Windows installers and attaches them
   to a draft GitHub release. Review and publish it.

## Questions

Open an issue or start a discussion. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of filing a public issue.
