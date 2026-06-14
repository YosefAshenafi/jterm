import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  readText as clipboardRead,
  writeText as clipboardWrite,
} from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { shellQuote } from "../shellquote";
import { DEFAULT_THEME, FONT_FAMILY, FONT_SIZE } from "./theme";

type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number };

interface PaneTerminal {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  ptyId: number | null;
  spawning: boolean;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

class TerminalManager {
  private panes = new Map<string, PaneTerminal>();
  /** Start directories pre-assigned to panes that haven't spawned yet — a
   * split hands the source pane's cwd to its new sibling through here. */
  private spawnCwd = new Map<string, Promise<string>>();
  /** User prefs applied to every terminal (see settings store). The accent
   * doubles as the cursor color so it tracks the UI border color. */
  private prefs = {
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: 1.0,
    cursorStyle: "block" as "block" | "bar" | "underline",
    cursorBlink: true,
    scrollback: 10000,
    accent: DEFAULT_THEME.cursor!,
  };
  /** Fired when a shell exits so the UI can close its pane. */
  onExit?: (paneId: string) => void;
  /** Fired when the shell sets the window/tab title. */
  onTitle?: (paneId: string, title: string) => void;
  /** Fired when a link is Option/Alt-clicked, to download it. */
  onLinkDownload?: (url: string) => void;
  /** The link the pointer is currently over (so right-click can act on it). */
  private hoveredLink: string | null = null;

  /** http(s) URL under the pointer right now, if any. */
  getHoveredLink(): string | null {
    return this.hoveredLink;
  }

  /** Apply preference changes to existing terminals and remember them for new
   * ones. Re-fits after a font-size change so the grid matches the new metrics. */
  setPrefs(
    prefs: Partial<{
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      cursorStyle: "block" | "bar" | "underline";
      cursorBlink: boolean;
      scrollback: number;
      accent: string;
    }>
  ): void {
    const fontChanged =
      (prefs.fontFamily != null && prefs.fontFamily !== this.prefs.fontFamily) ||
      (prefs.fontSize != null && prefs.fontSize !== this.prefs.fontSize) ||
      (prefs.lineHeight != null && prefs.lineHeight !== this.prefs.lineHeight);
    const accentChanged = prefs.accent != null && prefs.accent !== this.prefs.accent;
    this.prefs = { ...this.prefs, ...prefs };
    for (const [paneId, pane] of this.panes) {
      pane.term.options.fontFamily = this.prefs.fontFamily;
      pane.term.options.fontSize = this.prefs.fontSize;
      pane.term.options.lineHeight = this.prefs.lineHeight;
      pane.term.options.cursorStyle = this.prefs.cursorStyle;
      pane.term.options.cursorBlink = this.prefs.cursorBlink;
      pane.term.options.scrollback = this.prefs.scrollback;
      if (accentChanged) pane.term.options.theme = this.theme();
      if (fontChanged) this.fit(paneId);
    }
  }

  /** Terminal color theme with the cursor tinted to the current accent. */
  private theme() {
    return { ...DEFAULT_THEME, cursor: this.prefs.accent };
  }

  private ensure(paneId: string): PaneTerminal {
    const existing = this.panes.get(paneId);
    if (existing) return existing;

    const element = document.createElement("div");
    element.className = "terminal-host";

    const term = new Terminal({
      fontFamily: this.prefs.fontFamily,
      fontSize: this.prefs.fontSize,
      lineHeight: this.prefs.lineHeight,
      cursorStyle: this.prefs.cursorStyle,
      cursorBlink: this.prefs.cursorBlink,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: this.prefs.scrollback,
      theme: this.theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (!/^https?:\/\//i.test(uri)) return;
          if (event.altKey) this.onLinkDownload?.(uri);
          else void openUrl(uri);
        },
        {
          hover: (_e, text) => {
            this.hoveredLink = /^https?:\/\//i.test(text) ? text : null;
          },
          leave: () => {
            this.hoveredLink = null;
          },
        }
      )
    );
    term.open(element);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
    }

    const pane: PaneTerminal = { term, fit, element, ptyId: null, spawning: false };
    this.panes.set(paneId, pane);

    term.onData((data) => {
      if (pane.ptyId != null) this.queueWrite(paneId, pane.ptyId, data);
    });
    term.onTitleChange((title) => this.onTitle?.(paneId, title));

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (ev.type === "keydown" && pane.ptyId != null) {
          this.queueWrite(paneId, pane.ptyId, "\x1b\r");
        }
        return false;
      }
      return true;
    });

    return pane;
  }

  /** Attach the pane's terminal element into `container` (idempotent). */
  attach(paneId: string, container: HTMLElement): void {
    const pane = this.ensure(paneId);
    if (pane.element.parentElement !== container) container.appendChild(pane.element);
    this.fit(paneId);
  }

  /** Serialize writes per-pane so rapid keystrokes arrive in order. */
  private writeQueue = new Map<string, Promise<void>>();

  /** Queue a PTY write after the pane's pending writes. A failed write is
   * swallowed so a single rejection can't poison the chain and silently drop
   * every keystroke that follows. */
  private queueWrite(paneId: string, ptyId: number, data: string): void {
    const prev = this.writeQueue.get(paneId) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => invoke("pty_write", { id: ptyId, data }) as unknown as Promise<void>)
      .catch(() => {});
    this.writeQueue.set(paneId, next);
  }

  /** Pre-assign the directory a not-yet-spawned pane's shell starts in. */
  setSpawnCwd(paneId: string, cwd: Promise<string>): void {
    this.spawnCwd.set(paneId, cwd);
  }

  /** Pending pre-assigned start directory for a pane that hasn't spawned. */
  getSpawnCwd(paneId: string): Promise<string> | undefined {
    return this.spawnCwd.get(paneId);
  }

  /** Spawn the shell for a pane if it doesn't have one yet. */
  async spawn(paneId: string, cwd?: string): Promise<void> {
    const pane = this.ensure(paneId);
    if (pane.ptyId != null || pane.spawning) return;
    pane.spawning = true;

    const pending = this.spawnCwd.get(paneId);
    if (cwd == null && pending) {
      try {
        cwd = await pending;
      } catch {
      }
    }

    this.fit(paneId);
    const cols = pane.term.cols;
    const rows = pane.term.rows;

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (msg) => {
      if (this.panes.get(paneId) !== pane) return;
      if (msg.type === "data") pane.term.write(base64ToBytes(msg.data));
      else if (msg.type === "exit") this.onExit?.(paneId);
    };

    try {
      const id = await invoke<number>("pty_spawn", {
        cwd: cwd ?? null,
        shell: null,
        cols,
        rows,
        onEvent: channel,
      });
      if (this.panes.get(paneId) !== pane) {
        invoke("pty_kill", { id });
        return;
      }
      pane.ptyId = id;
    } catch (e) {
      if (this.panes.get(paneId) === pane) {
        pane.term.writeln(`\x1b[31mFailed to start shell: ${e}\x1b[0m`);
      }
    } finally {
      this.spawnCwd.delete(paneId);
      pane.spawning = false;
    }
  }

  /** Resize the terminal to its container and inform the PTY. */
  fit(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.element.isConnected) return;
    try {
      pane.fit.fit();
    } catch {
      return;
    }
    if (pane.ptyId != null) {
      invoke("pty_resize", { id: pane.ptyId, cols: pane.term.cols, rows: pane.term.rows });
    }
  }

  focus(paneId: string): void {
    this.panes.get(paneId)?.term.focus();
  }

  /** Backend pty id for a pane, if it has spawned. */
  getPtyId(paneId: string): number | null {
    return this.panes.get(paneId)?.ptyId ?? null;
  }

  /** Send literal text to a pane's shell (e.g. a path or a `cd` command). */
  sendText(paneId: string, text: string): void {
    const pane = this.panes.get(paneId);
    if (pane?.ptyId != null) {
      invoke("pty_write", { id: pane.ptyId, data: text });
      pane.term.focus();
    }
  }

  getSelection(paneId: string): string {
    return this.panes.get(paneId)?.term.getSelection() ?? "";
  }

  async copy(paneId: string): Promise<void> {
    const sel = this.getSelection(paneId);
    if (sel) await clipboardWrite(sel);
  }

  async paste(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane || pane.ptyId == null) return;
    const ptyId = pane.ptyId;
    const stillLive = () => this.panes.get(paneId) === pane && pane.ptyId != null;

    const pasteFilePath = (p: string) => {
      if (pane.term.modes.bracketedPasteMode) pane.term.paste(p);
      else invoke("pty_write", { id: ptyId, data: `${shellQuote(p)} ` });
    };

    const files = await invoke<string[]>("clipboard_file_paths").catch(() => [] as string[]);
    if (files.length > 0) {
      if (stillLive()) pasteFilePath(files[0]);
      return;
    }

    const text = await clipboardRead().catch(() => null);
    if (text) {
      pane.term.paste(text);
      return;
    }

    const path = await invoke<string | null>("save_clipboard_image").catch(() => null);
    if (path && stillLive()) pasteFilePath(path);
  }

  /** Dispose any terminals whose panes no longer exist in the layout. */
  reconcile(liveIds: Set<string>): void {
    for (const paneId of [...this.panes.keys()]) {
      if (!liveIds.has(paneId)) this.dispose(paneId);
    }
  }

  /** Dispose a single terminal (e.g. the bottom panel when its shell exits, so
   * the next open spawns a fresh shell). No-op if it doesn't exist. */
  disposePane(paneId: string): void {
    this.dispose(paneId);
  }

  private dispose(paneId: string): void {
    this.spawnCwd.delete(paneId);
    this.writeQueue.delete(paneId);
    const pane = this.panes.get(paneId);
    if (!pane) return;
    if (pane.ptyId != null) invoke("pty_kill", { id: pane.ptyId });
    pane.term.dispose();
    pane.element.remove();
    this.panes.delete(paneId);
  }
}

export const terminals = new TerminalManager();
