// User-customizable preferences, persisted to localStorage so they survive
// restarts. The accent drives every highlight in the UI (active-pane border,
// tab underlines, divider hover) via the `--accent` / `--pane-border` CSS
// variables; font size and cursor blink are pushed into every xterm instance.

import { FONT_FAMILY, FONT_SIZE } from "../terminal/theme";

export type CursorStyle = "block" | "bar" | "underline";

export interface Settings {
  /** Hex color (`#rrggbb`) for the active-pane border and other highlights. */
  accent: string;
  /** Monospace font stack used by every terminal. */
  fontFamily: string;
  fontSize: number;
  /** Font size (px) of the file editor — zoomed independently of terminals. */
  editorFontSize: number;
  /** Multiplier applied to the line box height (1 = tight). */
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Lines of scrollback kept per terminal. */
  scrollback: number;
}

export const DEFAULT_SETTINGS: Settings = {
  accent: "#5ac8fa",
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  editorFontSize: 13,
  lineHeight: 1.0,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
};

export const ACCENT_PRESETS = [
  "#5ac8fa", // blue (default)
  "#98c379", // green
  "#e5c07b", // amber
  "#e06c75", // red
  "#c678dd", // purple
  "#56b6c2", // teal
];

/** Font choices offered in settings. Each value is a CSS font stack that falls
 * back to the system monospace when the named face isn't installed. */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: "System Mono", value: FONT_FAMILY },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, monospace' },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Monaco", value: "Monaco, monospace" },
  { label: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", monospace' },
  { label: "Fira Code", value: '"Fira Code", monospace' },
  { label: "Courier New", value: '"Courier New", monospace' },
];

export const CURSOR_STYLES: { label: string; value: CursorStyle }[] = [
  { label: "Block", value: "block" },
  { label: "Bar", value: "bar" },
  { label: "Underline", value: "underline" },
];

export const SCROLLBACK_PRESETS = [1000, 5000, 10000, 50000, 100000];

const KEY = "jterm.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

/** `#rgb` / `#rrggbb` → `rgba(r, g, b, a)`, falling back to the default blue. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return `rgba(90, 200, 250, ${alpha})`;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
