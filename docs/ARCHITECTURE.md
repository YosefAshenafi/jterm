# Architecture

This is the map of how jterm is put together: the pieces, the data flow between
them, and the decisions that aren't obvious from reading any single file. If
you're about to make a non-trivial change, start here.

## The shape of it

jterm is a [Tauri](https://tauri.app) app, which means two halves talking over a
local IPC bridge:

- a **webview frontend**: React + TypeScript + [xterm.js](https://xtermjs.org),
  bundled by Vite, rendering the UI; and
- a **Rust backend**: the privileged side that spawns shells, touches the
  filesystem, and runs `git`.

The frontend can't open a PTY or read a file directly; it asks the backend to,
through `invoke("command_name", args)`. The backend exposes a fixed set of
commands (listed below) and nothing else. There's no network server and no
remote anything; both halves run on your machine, in one process tree.

```
┌─────────────────────────── webview (frontend) ───────────────────────────┐
│  React components ── store (useReducer) ── terminal manager (xterm.js)    │
│        │                    │                        │                    │
│        └──────────── invoke() / Channel ◀────────────┘                    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                 │  Tauri IPC
┌────────────────────────────────▼─────────────────────────────────────────┐
│  Rust backend:  PtyManager · file I/O · search · git                      │
│        │                                                                   │
│        └── portable-pty ──▶ your $SHELL / PowerShell                       │
└───────────────────────────────────────────────────────────────────────────┘
```

## The one decision to internalize: terminals live outside React

`src/terminal/manager.ts` owns a `Map<paneId, { term, fit, element, ptyId }>`.
The xterm.js `Terminal` objects, their DOM elements, and the backend PTY ids are
**not** React state. React components (`TerminalPane.tsx`) only ask the manager
to `attach` a pane's element into a container, and to `fit`/`focus` it.

Why: a terminal holds a lot of live, expensive state (the running shell, the
scrollback buffer, the WebGL context). If that lived in React, every split, tab
switch, or layout change would risk unmounting and recreating it, which would
kill the shell and wipe scrollback. By keeping terminals in a plain manager and
moving only their DOM nodes around, layout changes are cheap and non-destructive.

The cost is a small imperative bridge in `App.tsx`: the manager fires `onExit`
and `onTitle` callbacks, and an effect reconciles the manager's live set against
the panes that still exist in the tree (`terminals.reconcile(liveIds)`), disposing
terminals whose panes were closed. That bridge is the price of the invariant, and
it's worth it.

## Data flow: a keystroke and a line of output

**You type a key:**

1. xterm.js fires `term.onData(data)` in the manager.
2. The manager calls `invoke("pty_write", { id: ptyId, data })`.
3. `pty_write` (lib.rs) looks up the session and writes the bytes to the PTY's
   writer. The shell receives them.

**The shell prints something:**

1. Each PTY has a dedicated **reader thread** (spawned in `pty.rs`). It reads raw
   bytes from the PTY master in 8 KiB chunks.
2. It base64-encodes each chunk and sends it over the session's Tauri `Channel`
   as a `PtyEvent::Data`.
3. On the frontend, the channel's `onmessage` decodes the base64 back to bytes
   and calls `term.write(bytes)`.

Base64 is deliberate. A multi-byte UTF-8 sequence (or an escape sequence) can be
split across two reads. Shipping raw bytes through the JSON IPC boundary would
risk mangling them; base64 round-trips the exact bytes, and xterm.js reassembles
partial sequences on its end. When the shell exits, the reader thread sends
`PtyEvent::Exit`, the manager fires `onExit`, and the store closes the pane.

## Frontend

### The pane tree

A tab's layout is a binary tree (`state/types.ts`):

- a **leaf** is one terminal (`{ type: "leaf", id }`), and
- a **split** has two children, a direction (`row` for left/right with a
  vertical divider, `column` for top/bottom with a horizontal divider), and the
  two fraction `sizes` that sum to 1.

`state/tree.ts` holds the pure operations over that tree: `splitPane` (replace a
leaf with a split of itself + a new sibling), `removePane` (delete a leaf and
collapse any split left with one child), `setSplitSizes` (divider drag),
`collectLeaves`/`leafOrder` (enumeration and focus cycling). Every function
returns a new tree and mutates nothing, so the reducer stays immutable and React
re-renders predictably. `components/PaneTree.tsx` renders the tree recursively
and turns divider drags into `resizeSplit` actions.

### State management

`state/store.tsx` is the single store, exposed to components as a typed API via
context. It's intentionally a mix:

- a **`useReducer`** for the tab/pane structure, the part with non-trivial
  transitions (split, close-and-collapse, focus, zoom, rename), all in one pure
  reducer;
- plain **`useState`** for the looser bits (sidebar open/view, project root,
  settings); and
- a second **`useReducer`** (`state/editor.ts`) for open file buffers.

Two details that catch people:

- **Shell-driven titles never override a manual rename.** Once you double-click a
  tab to rename it, `titleManual` is set and `set-title` (from the shell's title
  escape) is ignored for that tab.
- **There's always at least one tab.** Closing the last tab/pane resets to a
  fresh tab rather than leaving an empty window.

### The editor

`state/editor.ts` models each open file as a buffer with `saved` (last on-disk
content, `null` until the read resolves) and `draft` (current editor text). A
buffer is *dirty* exactly when `draft !== saved`. Saving writes `draft` to disk
and sets `saved = draft`; closing a dirty buffer prompts first. Buffers are
**per terminal tab**: the store keeps one editor state per tab id (`editorMap`),
so a new tab opens empty and switching tabs restores that tab's own open files.
The active file is tracked separately so the editor column and the terminal can
each hold keyboard focus (`focusRegion` decides whether `⌘S`/`⌘W` hit the editor
or the terminal).

### Settings

`state/settings.ts` persists `{ accent, fontFamily, fontSize, editorFontSize,
lineHeight, cursorStyle, cursorBlink, scrollback }` to `localStorage`. An effect
in the store pushes them two ways: into CSS variables
(`--accent`, `--pane-border`) that drive every highlight in the UI, and into the
terminal manager's `setPrefs`, which updates every live xterm and re-fits after a
font-size change. The accent doubles as the terminal cursor color so the cursor
tracks the UI.

## Backend

All commands live in `src-tauri/src/lib.rs` and return `Result<T, String>` so
failures surface as rejected promises the UI can show. They group into:

| Group   | Commands                                                                   | Notes |
| ------- | -------------------------------------------------------------------------- | ----- |
| PTY     | `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`                          | Thin wrappers over `PtyManager` (pty.rs). |
| Files   | `read_dir`, `read_file`, `write_file`, `pane_cwd`                          | `read_file` refuses directories, binaries (NUL in the first 8 KiB), and files over 8 MB. |
| Search  | `search_in_folder`                                                         | Cancellable, parallel; see below. |
| Git     | `git_status`, `git_stage`(`_all`), `git_unstage`(`_all`), `git_discard`(`_all`), `git_diff`, `git_commit`, `git_push`, `git_init`, `git_publish` | Shell out to the system `git`; `git_publish` uses the GitHub CLI. |

### PTY management (`pty.rs`)

`PtyManager` owns every live session in a `Mutex<HashMap<u32, PtySession>>`,
keyed by an id handed back to the frontend. `spawn` opens a PTY via
[`portable-pty`](https://docs.rs/portable-pty), launches the shell
(`$SHELL`/`/bin/zsh` on Unix, `%COMSPEC%`/PowerShell on Windows) with
`TERM=xterm-256color`, and starts the reader thread. It records the child's pid
so `pane_cwd` can resolve the shell's working directory through the OS process
table (via [`sysinfo`](https://docs.rs/sysinfo)); that's how "Sync" and the
sidebar know which folder a pane is in.

### Search (`search_in_folder`)

This is the most interesting command, because it has to stay responsive while
you type into the search box. The design:

- **Generation counter.** Every query bumps an `AtomicU64`. A running search
  remembers the generation it started with and bails out the moment a newer
  search supersedes it (checked between directory reads and every 512 entries).
  So fast typing never piles up stale scans.
- **Two phases.** First a cheap directory walk enumerates candidate files,
  skipping hidden dirs and build/vendor dirs (`node_modules`, `target`, `dist`,
  …). Then worker threads (one per core, capped at 8) pull files from a shared
  cursor and scan their contents in parallel.
- **Bounded everywhere.** Files over 2 MB, binaries (NUL sniff), more than 40
  matches per file, lines over 500 chars, and a global cap of 1000 matches are
  all clamped, with a `truncated` flag so the UI can say so.
- It runs on `spawn_blocking`, off the async runtime's worker threads, so the UI
  thread is never blocked.

ASCII queries take a no-allocation case-insensitive substring path
(`ascii_ci_contains`); non-ASCII falls back to `to_lowercase().contains`.

### Git (`git_status` and friends)

Rather than link a git library, jterm shells out to the `git` already on your
`PATH`, so it inherits your config, credentials, and hooks. `git_status` parses
`git status --porcelain=v1 --branch -uall -z` (NUL-delimited, so filenames with
spaces or newlines are safe) into a branch, upstream, ahead/behind counts, and
per-file index/worktree status chars. The other commands are thin wrappers —
`git add` / `reset` / `checkout` / `diff` / `commit` / `push` / `init` — run in
the selected folder. **Publish** (`git_publish`) shells out to the
[GitHub CLI](https://cli.github.com) (`gh repo create … --push`) to create a new
public/private repo and push, falling back to `git push -u` when a remote already
exists.

## Security model

See [SECURITY.md](../SECURITY.md) for the trust model and how to report issues.
In short: the backend's surface is exactly the command list above; the Tauri
capability allowlist (`src-tauri/capabilities/default.json`) grants only the
plugin permissions the UI uses (clipboard read/write, dialog open/ask, opener);
and the file/search paths guard against binaries and oversized reads. There's no
network listener.

## Extending it

- **A new backend capability**: add a `#[tauri::command]` in `lib.rs`, register
  it in `generate_handler!`, grant any new permission in `capabilities/`, and
  call it with `invoke`. See CONTRIBUTING for the step-by-step.
- **A new sidebar view**: add it to the `SidebarView` union and the
  `ActivityBar`, and render it from `Sidebar.tsx`.
- **A new layout operation**: add a pure function in `tree.ts`, an action in the
  store reducer, and a key/menu binding in `App.tsx`. Keep the tree ops pure.
- **Theming/config**: today the defaults live in `terminal/theme.ts` and user
  prefs in `settings.ts`; a real config file is the next planned step.
