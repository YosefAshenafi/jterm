// Helpers shared by the project toolbar and file-tree sidebar.

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { terminals } from "./terminal/manager";

const isWindows = /windows/i.test(navigator.userAgent);

/** Quote a path for insertion into the pane's shell (`cd` from the file tree).
 * POSIX single-quote escaping for zsh/bash; on Windows, PowerShell literal
 * strings (embedded quotes doubled) to match the default shell the backend
 * spawns. Both forms keep `&`, `;`, `$` and friends inert, so a hostile folder
 * name can't smuggle a second command into the terminal. */
export function shellQuote(p: string): string {
  if (isWindows) return `'${p.replace(/'/g, "''")}'`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Last path segment, tolerant of both `/` and `\` separators. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Parent directory of a path (everything before the last separator). */
export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx <= 0 ? "" : trimmed.slice(0, idx);
}

/** A pane's shell working directory, falling back to the home directory. Used to
 * seed the project folder shown in the sidebar / searched / git-managed. */
export async function resolveCwd(paneId: string | null): Promise<string> {
  if (paneId) {
    const ptyId = terminals.getPtyId(paneId);
    if (ptyId != null) {
      const cwd = await invoke<string | null>("pane_cwd", { id: ptyId });
      if (cwd) return cwd;
    }
  }
  return homeDir();
}
