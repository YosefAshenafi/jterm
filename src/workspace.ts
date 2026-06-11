// Helpers shared by the project toolbar and file-tree sidebar.

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { terminals } from "./terminal/manager";

export { shellQuote } from "./shellquote";

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

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  apng: "image/apng",
};

/** MIME type for a path's image extension, or null when it isn't an image we
 * preview. Drives whether the editor renders a picture instead of text. */
export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
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
    // The pane's shell hasn't spawned yet (e.g. splitting a pane that was
    // itself just split) — inherit the directory it is about to start in.
    const pending = terminals.getSpawnCwd(paneId);
    if (pending) return pending;
  }
  return homeDir();
}
