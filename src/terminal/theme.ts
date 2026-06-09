// Terminal appearance. P4 will move these into a user config file; for now they
// are the single source of truth for font + colors so the UI and xterm match.

import type { ITheme } from "@xterm/xterm";

export const FONT_FAMILY =
  '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace';
export const FONT_SIZE = 13;

// A calm, low-contrast dark scheme.
export const DEFAULT_THEME: ITheme = {
  background: "#0d1017",
  foreground: "#c5c9d1",
  cursor: "#5ac8fa",
  cursorAccent: "#0d1017",
  selectionBackground: "#2a3b53",
  black: "#1b1f27",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};
