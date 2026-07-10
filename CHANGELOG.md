# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Session restore**: reopening the app — after a quit, a crash, or a reboot —
  brings back each tab's open files (re-read from disk when the tab is shown),
  the file it was showing, unsaved edits, and the terminal's working directory,
  not just the tab names. Files deleted while the app was closed show an error
  in their tab, and a vanished working directory falls back to the default.
- **⌘C / ⌘V in the Explorer**: point at the file tree and press ⌘V
  (`Ctrl+Shift+V` on Windows/Linux) to paste into the selected folder — or a
  selected file's folder, or the project root — and ⌘C to copy the selected
  file or folder. Uses the same rules as the context menu's Copy/Paste, so
  files copied in Finder paste in too.
- **Copy & paste files in the Explorer**: right-click a file or folder to copy
  it, then paste into any folder (onto a folder drops files inside it; onto a
  file, into its folder). Files copied in Finder paste in too, and the more
  recent of the two copies wins. Pastes never overwrite — a name clash gains a
  ` copy` suffix — and folders are copied recursively.
- **Reveal in Finder / File Explorer**: right-click any file or folder to show
  it in the system file manager.

## [0.2.0] - 2026-06-14

### Added

- **Linux builds**: the release pipeline now publishes `.deb`, AppImage, and
  `.rpm` packages alongside the macOS and Windows installers.
- **Publish to GitHub**: from Source Control, create a new public or private
  repository and push the current branch in one step (via the GitHub CLI), with
  a clickable link to the new repo. Plus discarding individual or all changes.
- **Markdown preview**: open a `.md` file and toggle a rendered preview from the
  editor status bar.
- **Per-tab editor buffers**: each terminal tab keeps its own open files, so a
  new tab opens empty and switching tabs restores that tab's files.
- **Editor auto-indent** by file type: new lines copy the current indentation and
  deepen after a block opener (`{`/`[`/`(`, or a trailing `:` in Python), with
  matching bracket pairs split onto their own lines.
- **Quick Open** (`⌘P`), **Go to Line** (`⌘G`), and **Find in file** (`⌘F`).
- **Bottom terminal panel** (`⌘J`, `⌘⇧J`): a VS Code-style drawer of extra
  terminals with its own tabs.
- **Drag a pane** onto another pane's edge, onto a tab, or out into a new tab.
- **Explorer toggle** (`⌘B`) and an edge-hover peek for the sidebar.
- Double-click the title bar to maximize; drag the title bar to move the window.

### Changed

- Removed the dialog plugin to eliminate unnecessary macOS permission prompts.

### Fixed

- macOS: Copy/Cut/Paste/Select-All work in text fields such as the Quick Open
  box (the native Edit menu is intentionally stripped, so these are handled in
  app).
- `⌘B` hides the sidebar immediately, even while the pointer is hovering it.

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

[Unreleased]: https://github.com/yosefashenafi/jterm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yosefashenafi/jterm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yosefashenafi/jterm/releases/tag/v0.1.0
