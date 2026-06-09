mod pty;

use pty::{PtyEvent, PtyManager};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

/// One entry in a directory listing for the file-tree sidebar.
#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

/// List a directory, folders first then files, alphabetically.
#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        // Follow symlinks so linked directories show as folders.
        let is_dir = std::fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Largest file the in-app editor will open. Bigger files are refused rather
/// than truncated — truncating then saving would silently destroy the tail.
const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;

/// Read a text file for the editor. Refuses directories, binary files (a NUL in
/// the first 8 KiB), and files larger than `MAX_EDIT_BYTES`.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Cannot open a directory".into());
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err(format!(
            "File is too large to open ({:.1} MB)",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("Binary file — open it in the terminal instead".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write editor contents back to disk, overwriting the file.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Current working directory of a pane's shell (for the project toolbar/sidebar).
#[tauri::command]
fn pane_cwd(state: State<PtyManager>, id: u32) -> Option<String> {
    state.cwd(id)
}

// ---- Full-text search -------------------------------------------------------

/// Non-hidden directories never descended into during a workspace search.
/// (Hidden dirs — names starting with `.` — are skipped separately.)
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "vendor", "venv", "__pycache__",
    "coverage", "out", "bin", "obj",
];
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SEARCH_MAX_RESULTS: usize = 1000;
const SEARCH_MAX_PER_FILE: usize = 40;
const SEARCH_LINE_CAP: usize = 500;

/// Monotonic search generation. Each new query bumps it; in-flight searches for
/// older generations bail out early so rapid typing never piles up scans.
#[derive(Default)]
struct SearchState {
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
struct SearchMatch {
    line: u32,
    text: String,
}

#[derive(Serialize)]
struct FileResult {
    path: String,
    rel: String,
    matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
struct SearchResults {
    results: Vec<FileResult>,
    truncated: bool,
}

/// ASCII case-insensitive substring test with no per-line allocation. `needle`
/// must already be lowercased ASCII.
fn ascii_ci_contains(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return needle.is_empty();
    }
    let first = needle[0];
    let last = hay.len() - needle.len();
    let mut i = 0;
    while i <= last {
        if hay[i].to_ascii_lowercase() == first
            && needle[1..]
                .iter()
                .zip(&hay[i + 1..])
                .all(|(n, h)| *n == h.to_ascii_lowercase())
        {
            return true;
        }
        i += 1;
    }
    false
}

/// Scan one file's contents for `needle`, returning its matches (empty if none,
/// binary, or oversized).
fn search_file(
    p: &std::path::Path,
    needle: &str,
    needle_bytes: &[u8],
    ascii: bool,
) -> Vec<SearchMatch> {
    match std::fs::metadata(p) {
        Ok(m) if m.len() <= SEARCH_MAX_FILE_BYTES => {}
        _ => return Vec::new(),
    }
    let bytes = match std::fs::read(p) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Vec::new(); // binary
    }
    // Borrow as &str when valid UTF-8 (no copy); lossy only on bad bytes.
    let text = String::from_utf8_lossy(&bytes);
    let mut matches = Vec::new();
    for (lineno, line) in text.lines().enumerate() {
        let hit = if ascii {
            ascii_ci_contains(line.as_bytes(), needle_bytes)
        } else {
            line.to_lowercase().contains(needle)
        };
        if !hit {
            continue;
        }
        let snippet: String = if line.len() > SEARCH_LINE_CAP {
            line.chars().take(SEARCH_LINE_CAP).collect()
        } else {
            line.to_string()
        };
        matches.push(SearchMatch { line: (lineno + 1) as u32, text: snippet });
        if matches.len() >= SEARCH_MAX_PER_FILE {
            break;
        }
    }
    matches
}

/// Run the (blocking) recursive search, bailing as soon as a newer search has
/// superseded `my_gen`. Enumerates candidate files (skipping hidden + build/
/// vendor dirs), then scans their contents across all cores.
fn search_blocking(
    path: &str,
    needle: &str,
    generation: &AtomicU64,
    my_gen: u64,
) -> SearchResults {
    let empty = || SearchResults { results: vec![], truncated: false };
    let superseded = || generation.load(Ordering::Relaxed) != my_gen;
    let root = std::path::PathBuf::from(path);

    // 1) Enumerate candidate files. Directory walking is cheap; the costly part
    //    (reading + scanning contents) is parallelized below.
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let mut stack = vec![root.clone()];
    let mut checked = 0usize;
    while let Some(dir) = stack.pop() {
        if superseded() {
            return empty();
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.filter_map(|e| e.ok()) {
            checked += 1;
            if checked % 512 == 0 && superseded() {
                return empty();
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref()) {
                    stack.push(entry.path());
                }
            } else if file_type.is_file() {
                files.push(entry.path());
            }
        }
    }
    if superseded() {
        return empty();
    }

    // 2) Scan file contents in parallel. Workers pull from a shared cursor and
    //    stop early once cancelled or the result cap is reached.
    let ascii = needle.is_ascii();
    let needle_bytes = needle.as_bytes();
    let next = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let out: Mutex<Vec<FileResult>> = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if generation.load(Ordering::Relaxed) != my_gen
                    || total.load(Ordering::Relaxed) >= SEARCH_MAX_RESULTS
                {
                    break;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= files.len() {
                    break;
                }
                let p = &files[i];
                let matches = search_file(p, needle, needle_bytes, ascii);
                if matches.is_empty() {
                    continue;
                }
                let added = matches.len();
                let rel = p
                    .strip_prefix(&root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned();
                let result = FileResult { path: p.to_string_lossy().into_owned(), rel, matches };
                out.lock().unwrap().push(result);
                total.fetch_add(added, Ordering::Relaxed);
            });
        }
    });

    if superseded() {
        return empty();
    }
    let mut results = out.into_inner().unwrap();
    let truncated = total.load(Ordering::Relaxed) >= SEARCH_MAX_RESULTS;
    results.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    SearchResults { results, truncated }
}

/// Recursively search text files under `path` for `query` (case-insensitive
/// substring), grouped by file. Runs off the UI thread and cancels itself when
/// a newer search starts, so the interface never freezes while typing.
#[tauri::command]
async fn search_in_folder(
    state: State<'_, SearchState>,
    path: String,
    query: String,
) -> Result<SearchResults, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchResults { results: vec![], truncated: false });
    }
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || search_blocking(&path, &needle, &generation, my_gen))
        .await
        .map_err(|e| e.to_string())
}

// ---- Git --------------------------------------------------------------------

/// Run a git subcommand in `cwd`, returning stdout on success or stderr on error.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            err
        })
    }
}

#[derive(Serialize)]
struct GitFile {
    path: String,
    /// Index (staged) status char and worktree status char from `git status`.
    x: String,
    y: String,
}

#[derive(Serialize)]
struct GitStatus {
    is_repo: bool,
    /// Absolute repository top-level. Porcelain paths are relative to this, and
    /// every other git command should run here too.
    root: String,
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

fn extract_count(s: &str, key: &str) -> u32 {
    match s.find(key) {
        Some(idx) => s[idx + key.len()..]
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0),
        None => 0,
    }
}

/// Porcelain status + branch/ahead/behind for the Source Control panel.
#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let inside = std::process::Command::new("git")
        .current_dir(&path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    let is_repo = matches!(&inside, Ok(o) if o.status.success()
        && String::from_utf8_lossy(&o.stdout).trim() == "true");
    if !is_repo {
        return Ok(GitStatus {
            is_repo: false,
            root: String::new(),
            branch: String::new(),
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
        });
    }

    let root = run_git(&path, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let raw = run_git(&path, &["status", "--porcelain=v1", "--branch", "-uall", "-z"])?;
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut branch = String::new();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();

    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        if rec.is_empty() {
            i += 1;
            continue;
        }
        if let Some(rest) = rec.strip_prefix("## ") {
            if let Some(name) = rest.strip_prefix("No commits yet on ") {
                branch = name.to_string();
            } else if let Some((b, track)) = rest.split_once("...") {
                branch = b.to_string();
                let (up, counts) = match track.split_once(' ') {
                    Some((up, counts)) => (up.to_string(), Some(counts)),
                    None => (track.to_string(), None),
                };
                upstream = Some(up);
                if let Some(counts) = counts {
                    ahead = extract_count(counts, "ahead");
                    behind = extract_count(counts, "behind");
                }
            } else {
                branch = rest.to_string();
            }
            i += 1;
            continue;
        }
        if rec.len() >= 3 {
            let x = &rec[0..1];
            let y = &rec[1..2];
            let p = &rec[3..];
            let is_rename = x == "R" || x == "C";
            files.push(GitFile { path: p.to_string(), x: x.to_string(), y: y.to_string() });
            if is_rename {
                i += 1; // skip the rename source path that follows
            }
        }
        i += 1;
    }

    Ok(GitStatus { is_repo: true, root, branch, upstream, ahead, behind, files })
}

#[tauri::command]
fn git_stage(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["add", "--", &file]).map(|_| ())
}

#[tauri::command]
fn git_stage_all(path: String) -> Result<(), String> {
    run_git(&path, &["add", "-A"]).map(|_| ())
}

#[tauri::command]
fn git_unstage(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["reset", "-q", "HEAD", "--", &file]).map(|_| ())
}

#[tauri::command]
fn git_commit(path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".into());
    }
    run_git(&path, &["commit", "-m", &message])
}

#[tauri::command]
fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

#[tauri::command]
fn git_init(path: String) -> Result<String, String> {
    run_git(&path, &["init"])
}

/// Spawn a shell in a new PTY; returns the pty id used by the other commands.
#[tauri::command]
fn pty_spawn(
    state: State<PtyManager>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    state.spawn(cwd, shell, cols, rows, on_event)
}

/// Forward input (keystrokes, pasted text) to a shell.
#[tauri::command]
fn pty_write(state: State<PtyManager>, id: u32, data: String) -> Result<(), String> {
    state.write(id, data.as_bytes())
}

/// Resize a PTY when its pane changes size.
#[tauri::command]
fn pty_resize(state: State<PtyManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(id, cols, rows)
}

/// Kill a shell when its pane is closed.
#[tauri::command]
fn pty_kill(state: State<PtyManager>, id: u32) -> Result<(), String> {
    state.kill(id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .manage(SearchState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            write_file,
            pane_cwd,
            search_in_folder,
            git_status,
            git_stage,
            git_stage_all,
            git_unstage,
            git_commit,
            git_push,
            git_init
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
