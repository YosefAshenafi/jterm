// User-customizable preferences, persisted to localStorage so they survive
// restarts. The accent drives every highlight in the UI (active-pane border,
// tab underlines, divider hover) via the `--accent` / `--pane-border` CSS
// variables; font size and cursor blink are pushed into every xterm instance.

import { FONT_SIZE } from "../terminal/theme";

export interface Settings {
  /** Hex color (`#rrggbb`) for the active-pane border and other highlights. */
  accent: string;
  fontSize: number;
  cursorBlink: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  accent: "#5ac8fa",
  fontSize: FONT_SIZE,
  cursorBlink: true,
};

export const ACCENT_PRESETS = [
  "#5ac8fa", // blue (default)
  "#98c379", // green
  "#e5c07b", // amber
  "#e06c75", // red
  "#c678dd", // purple
  "#56b6c2", // teal
];

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
