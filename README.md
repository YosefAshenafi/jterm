<div align="center">

<img src="public/jterm.png" alt="jterm logo" width="200" />

# jterm

**A fast, native terminal for macOS and Windows** — tabs, recursive split panes,
and real mouse support, with a VS Code-style file tree, editor, search, and Git
panel when you need them.

[![CI](https://github.com/yosefashenafi/jterm/actions/workflows/ci.yml/badge.svg)](https://github.com/yosefashenafi/jterm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/yosefashenafi/jterm?sort=semver)](https://github.com/yosefashenafi/jterm/releases)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

</div>

> One codebase: a Rust backend ([Tauri](https://tauri.app)) and a React/TypeScript
> frontend driving [xterm.js](https://xtermjs.org/).

## Contents

- [Why jterm](#why-jterm)
- [Features](#features)
- [Install](#install)
- [Develop](#develop)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [Releasing](#releasing)
- [License](#license)

## Why jterm

Most terminals make you choose: a fast, no-frills terminal *or* a heavy IDE
terminal bolted onto an editor. jterm is a small, focused middle ground. It's a
real terminal first: a true PTY per pane, GPU text rendering, and full mouse
reporting so `vim`/`htop`/`tmux`/`lazygit` behave. On top of that there is just
enough workspace (tree, editor, search, Git) to stop reaching for another
window. It starts in well under a second and the whole app is a few thousand
lines you can read in an afternoon, which is the point: fork it and make it
yours.

## Features

**Terminal**

- A real PTY per pane (`$SHELL` on macOS, PowerShell/ConPTY on Windows) with a
  correct `TERM` and proper `SIGWINCH` on resize.
- GPU rendering through xterm.js's WebGL renderer, falling back to DOM rendering
  where WebGL isn't available.
- Mouse reporting (SGR 1006 + modes 1000/1002/1003), so full-screen TUIs get
  your clicks, scroll, and drag. Plus selection, copy/paste, and a right-click
  menu (Split / Copy / Paste / Close).

**Layout**

- Tabs: `+` to add, `×` to close, click to switch, double-click to rename.
- Recursive split panes, left/right or top/bottom, nested as deep as you like.
  Drag the dividers to resize; each pane is its own live shell.
- **Drag a pane** onto another pane's edge, onto a tab, or out into a new tab.
- Maximize a pane to fill the workspace and back (`⌘M`).
- **Bottom panel** (`⌘J`): a VS Code-style drawer of extra terminals with its own
  tabs (`⌘⇧J` adds one).
- Switching tabs or splitting **never kills a running shell**: terminals live
  outside React, keyed by pane id, so layout changes only move their DOM around.

**Workspace** (optional, off until you open a folder)

- **Explorer**: a lazy-loaded file tree. Double-click a folder to `cd` the
  active terminal into it; click a file to open it in the editor.
- **Search** (`⌘⇧F`): full-text search across the folder. It runs off the UI
  thread, across all your cores, and cancels itself when you keep typing, so the
  window never freezes. Skips `node_modules`, `.git`, `target`, binaries, etc.
- **Source Control** (`⌘⇧G`): branch, ahead/behind, staged vs. unstaged changes,
  stage/unstage/discard, a commit box (`⌘↵`), and push. **Publish to GitHub**
  creates a new public or private repo and pushes in one step (via the GitHub
  CLI). Shells out to the `git` on your `PATH`; non-repos offer **Initialize
  Repository**.
- **Editor**: a column between the tree and the terminal. Tabbed buffers (each
  terminal tab keeps its own), syntax highlighting, file-type-aware auto-indent,
  a line-number gutter, undo/redo, and save (`⌘S`) with a guard before discarding
  unsaved changes. Refuses binaries and files over 8 MB.
- **Markdown preview**: open a `.md` file and toggle a rendered **Preview** from
  the editor status bar.
- **Quick Open** (`⌘P`), **Go to Line** (`⌘G`), and **Find in file** (`⌘F`).

**Appearance**: a settings panel for accent color (which also tints the
terminal cursor), font family and size, line height, cursor style and blink, and
scrollback. Changes apply live and persist.

## Install

### Download a build

Grab the installer for your OS from the
[Releases page](https://github.com/yosefashenafi/jterm/releases):

- **macOS**: `.dmg`, drag jterm into Applications.
- **Windows**: `.msi` or the NSIS `.exe`.

Builds are currently unsigned, so the OS will warn you the first time. On macOS,
right-click the app and choose **Open** to get past Gatekeeper; on Windows,
choose **More info**, then **Run anyway**. (Signing/notarization is on the
roadmap.)

### Build from source

You'll need:

- [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- [Rust](https://rustup.rs) (stable)
- A platform toolchain:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11)

```sh
pnpm install
pnpm tauri build        # native installer in src-tauri/target/release/bundle/
```

Tauri does not cross-compile, so build each OS on that OS (or use the release
workflow in CI; see [Releasing](#releasing)).

## Develop

```sh
pnpm install
pnpm tauri dev          # Vite + the app window, with hot reload
```

The frontend entry point is [`src/main.tsx`](src/main.tsx); the backend entry
point is [`src-tauri/src/main.rs`](src-tauri/src/main.rs).

Quick check that it works:

1. A shell prompt appears. Run `ls` (or `dir`) and see output.
2. `⌘T` opens a second tab; `⌘D` splits left/right, `⌘⇧D` splits top/bottom.
   Drag a divider to resize. Each pane is an independent shell.
3. Run `htop` (or `vim`) and click/scroll inside; it reacts to the mouse.
4. Select text, right-click to Copy, right-click to Paste.

### Test

```sh
pnpm test               # frontend unit tests (Vitest), watch mode
pnpm test:run           # one-shot, used by CI
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

Tests cover the pure logic where bugs hide: the pane-tree operations, the editor
buffer reducer, settings parsing, and the backend's search-match and Git-status
parsing helpers.

## Keyboard shortcuts

Everything below is also reachable with the mouse (tab-bar buttons, divider
drag, activity bar, right-click menu), so you never *need* the keyboard. macOS
bindings are shown; on **Windows/Linux** substitute **Ctrl+Shift** for ⌘, so
plain `^C`/`^D`/`^W` stay with the shell.

**Tabs & panes**

| Action                             | Shortcut  |
| ---------------------------------- | --------- |
| New tab                            | ⌘T        |
| Switch to tab N                    | ⌘1 … ⌘9   |
| Close focused pane / file tab      | ⌘W        |
| Split left / right                 | ⌘D        |
| Split top / bottom                 | ⌘⇧D       |
| Cycle pane focus                   | ⌘] / ⌘[   |
| Maximize / restore the active pane | ⌘M        |

**Workspace & panels**

| Action                            | Shortcut |
| --------------------------------- | -------- |
| Toggle the file explorer          | ⌘B       |
| Search across the folder          | ⌘⇧F      |
| Source Control (Git)              | ⌘⇧G      |
| Toggle the bottom terminal panel  | ⌘J       |
| New terminal in the bottom panel  | ⌘⇧J      |
| Quick Open files                  | ⌘P       |

**Editor**

| Action                | Shortcut       |
| --------------------- | -------------- |
| Save the active file  | ⌘S             |
| Find in file          | ⌘F             |
| Go to line            | ⌘G             |
| Zoom in / out / reset | ⌘+ / ⌘- / ⌘0   |

**Clipboard**

| Action          | Shortcut |
| --------------- | -------- |
| Copy selection  | ⌘C       |
| Paste           | ⌘V       |

> The single-key shortcuts (⌘B, ⌘P, ⌘G, ⌘F, ⌘J, zoom) are macOS-only for now;
> the chorded ones work on Windows/Linux via Ctrl+Shift.

## Configuration

There's no config file yet (it's [planned](#roadmap)). Today:

- **Appearance**: accent color, font, line height, cursor, and scrollback live
  in the in-app **Settings** panel (the gear, top-right) and persist to
  `localStorage`.
- **Theme defaults**: the color scheme and font stack are in
  [`src/terminal/theme.ts`](src/terminal/theme.ts). Edit there to change the
  built-in defaults.
- **Dev networking**: set `TAURI_DEV_HOST` to run `pnpm tauri dev` against a
  device on your network (used by Vite's HMR config).

## Architecture

The one design decision worth knowing up front: **xterm.js terminals and their
PTYs live outside React**, in a plain manager keyed by pane id. React components
only attach/detach the terminal's DOM element. That's why splitting a pane or
switching tabs never disturbs a running shell or its scrollback.

```
src-tauri/                 Rust backend (Tauri)
  src/pty.rs               PtyManager: spawn/write/resize/kill + per-PTY reader thread
  src/lib.rs               Tauri commands (pty, files, search, git) + setup
src/
  state/                   pane-tree model, pure tree ops, store, editor + settings
  terminal/                xterm + PTY manager (lives outside React), theme
  components/              tab bar, toolbar, sidebar, panels, editor, pane tree, …
  workspace.ts             path + cwd helpers
  App.tsx                  layout, keyboard shortcuts, lifecycle wiring
```

For the full data flow, the backend command surface, and the invariants to keep
when you extend it, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Roadmap

- **Config file**: user config for font, theme, default shell, and cursor, plus
  more built-in themes. (`src/terminal/theme.ts` is the current seed.)
- **Session restore**: persist and restore the tab/split layout and per-pane
  cwd across restarts; find-in-scrollback.
- **Signed releases**: Developer ID notarization on macOS and Authenticode on
  Windows so installs are warning-free.

## Known limitations

- Config is compile-time; no user config file yet.
- Layout and sessions don't survive a restart yet.
- Throughput on huge output bursts is bounded by xterm.js, not a custom GPU grid
  renderer. That's fine for interactive use, not for `cat`-ing a gigabyte.
- Linux isn't a published target yet. Tauri supports it, so it's mostly a
  matter of CI and testing; contributions welcome.

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the project layout, and the
few invariants to respect. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

Pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
the macOS and Windows installers and attaches them to a GitHub release. See
CONTRIBUTING for the steps.

## License

[MIT](LICENSE) © Yosef Ashenafi
