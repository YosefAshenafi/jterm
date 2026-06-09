// Owns one xterm.js Terminal + PTY per pane id. Terminals live OUTSIDE React so
// that re-renders (splitting, tab switches, layout changes) never destroy a
// running shell or its scrollback. React components only attach/detach the
// terminal's DOM element and ask the manager to fit/focus/dispose.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  readText as clipboardRead,
  writeText as clipboardWrite,
} from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
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
  /** User prefs applied to every terminal (see settings store). The accent
   * doubles as the cursor color so it tracks the UI border color. */
  private prefs = { fontSize: FONT_SIZE, cursorBlink: true, accent: DEFAULT_THEME.cursor! };
  /** Fired when a shell exits so the UI can close its pane. */
  onExit?: (paneId: string) => void;
  /** Fired when the shell sets the window/tab title. */
  onTitle?: (paneId: string, title: string) => void;

  /** Apply preference changes to existing terminals and remember them for new
   * ones. Re-fits after a font-size change so the grid matches the new metrics. */
  setPrefs(prefs: Partial<{ fontSize: number; cursorBlink: boolean; accent: string }>): void {
    const fontChanged = prefs.fontSize != null && prefs.fontSize !== this.prefs.fontSize;
    const accentChanged = prefs.accent != null && prefs.accent !== this.prefs.accent;
    this.prefs = { ...this.prefs, ...prefs };
    for (const [paneId, pane] of this.panes) {
      pane.term.options.fontSize = this.prefs.fontSize;
      pane.term.options.cursorBlink = this.prefs.cursorBlink;
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
      fontFamily: FONT_FAMILY,
      fontSize: this.prefs.fontSize,
      cursorBlink: this.prefs.cursorBlink,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: this.theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(element);
    try {
      // GPU renderer; falls back to the DOM renderer if WebGL is unavailable.
      term.loadAddon(new WebglAddon());
    } catch {
      /* no WebGL — xterm keeps its default renderer */
    }

    const pane: PaneTerminal = { term, fit, element, ptyId: null, spawning: false };
    this.panes.set(paneId, pane);

    term.onData((data) => {
      if (pane.ptyId != null) invoke("pty_write", { id: pane.ptyId, data });
    });
    term.onTitleChange((title) => this.onTitle?.(paneId, title));

    return pane;
  }

  /** Attach the pane's terminal element into `container` (idempotent). */
  attach(paneId: string, container: HTMLElement): void {
    const pane = this.ensure(paneId);
    if (pane.element.parentElement !== container) container.appendChild(pane.element);
    this.fit(paneId);
  }

  /** Spawn the shell for a pane if it doesn't have one yet. */
  async spawn(paneId: string, cwd?: string): Promise<void> {
    const pane = this.ensure(paneId);
    if (pane.ptyId != null || pane.spawning) return;
    pane.spawning = true;

    this.fit(paneId);
    const cols = pane.term.cols;
    const rows = pane.term.rows;

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (msg) => {
      if (msg.type === "data") pane.term.write(base64ToBytes(msg.data));
      else if (msg.type === "exit") this.onExit?.(paneId);
    };

    try {
      pane.ptyId = await invoke<number>("pty_spawn", {
        cwd: cwd ?? null,
        shell: null,
        cols,
        rows,
        onEvent: channel,
      });
    } finally {
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
    const text = await clipboardRead();
    if (text) invoke("pty_write", { id: pane.ptyId, data: text });
  }

  /** Dispose any terminals whose panes no longer exist in the layout. */
  reconcile(liveIds: Set<string>): void {
    for (const paneId of [...this.panes.keys()]) {
      if (!liveIds.has(paneId)) this.dispose(paneId);
    }
  }

  private dispose(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    if (pane.ptyId != null) invoke("pty_kill", { id: pane.ptyId });
    pane.term.dispose();
    pane.element.remove();
    this.panes.delete(paneId);
  }
}

export const terminals = new TerminalManager();
