// Lives in its own module (not workspace.ts) so the terminal manager can quote
// paths without a circular import — workspace.ts imports the manager.

const isWindows = /windows/i.test(navigator.userAgent);

/** Quote a path for insertion into the pane's shell (`cd` from the file tree,
 * pasted image paths). POSIX single-quote escaping for zsh/bash; on Windows,
 * PowerShell literal strings (embedded quotes doubled) to match the default
 * shell the backend spawns. Both forms keep `&`, `;`, `$` and friends inert,
 * so a hostile folder name can't smuggle a second command into the terminal. */
export function shellQuote(p: string): string {
  if (isWindows) return `'${p.replace(/'/g, "''")}'`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
