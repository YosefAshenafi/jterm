# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet. See the [roadmap](README.md#roadmap) for what's planned._

## [0.1.0] - 2026-06-10

The first public release. A fast, native terminal for macOS and Windows with
tabs, recursive split panes, full mouse support, and a VS Code-style workspace.

### Added

- **Terminal core**
  - Real PTY per pane (`$SHELL` on macOS, PowerShell/ConPTY on Windows) with a
    correct `TERM` and `SIGWINCH` propagation on resize.
  - GPU rendering via xterm.js WebGL, with automatic fallback to DOM rendering.
  - In-terminal mouse reporting (SGR 1006 + modes 1000/1002/1003) so TUIs like
    `vim`, `htop`, `tmux`, and `lazygit` receive clicks, scroll, and drag.
  - Mouse text selection with copy/paste and a right-click context menu.
- **Layout**
  - Tabs: add, close, click to switch, double-click to rename, `⌘1…⌘9` to jump.
  - Recursive horizontal/vertical split panes with draggable, resizable dividers.
  - Maximize/restore the active pane (`⌘M`).
  - Terminals live outside React, so splitting or switching tabs never destroys a
    running shell or its scrollback.
- **Workspace**
  - Project toolbar showing the opened folder, with Open Folder, Sync-to-cwd,
    split, and new-tab actions.
  - VS Code-style sidebar with three views: Explorer (lazy file tree), Search
    (parallel full-text search, `⌘⇧F`), and Source Control (Git status, stage,
    commit, push, init; `⌘⇧G`).
  - File editor column with tabbed buffers, dirty tracking, a line-number gutter,
    save (`⌘S`), and an unsaved-changes guard on close.
- **Settings**: accent color, terminal font size, and cursor blink, applied live
  and persisted to `localStorage`.

### Security

- File editor refuses binary files and files larger than 8 MB rather than
  truncating them.
- Search skips build/vendor directories, hidden directories, binary files, and
  files larger than 2 MB, and cancels superseded queries so rapid typing never
  piles up scans.

[Unreleased]: https://github.com/yosefashenafi/jterm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yosefashenafi/jterm/releases/tag/v0.1.0
