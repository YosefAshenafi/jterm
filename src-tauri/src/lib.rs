mod pty;

use pty::{PtyEvent, PtyManager};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::menu::{Menu, PredefinedMenuItem, SubmenuBuilder};
use tauri::State;

/// One entry in a directory listing for the file-tree sidebar.
#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

/// Run a blocking closure off the async runtime, surfacing panics as errors.
/// Filesystem and subprocess commands go through this so a slow disk, a big
/// repo, or a network mount can never freeze the UI thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// List a directory, folders first then files, alphabetically.
#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    blocking(move || {
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
    })
    .await
}

/// Largest file the in-app editor will open. Bigger files are refused rather
/// than truncated — truncating then saving would silently destroy the tail.
const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;

/// Read a text file for the editor. Refuses directories, binary files (a NUL in
/// the first 8 KiB), files larger than `MAX_EDIT_BYTES`, and non-UTF-8 text —
/// lossy-decoding a Latin-1 or Shift-JIS file and saving it back would silently
/// replace every unmapped byte with U+FFFD.
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    blocking(move || {
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
        String::from_utf8(bytes)
            .map_err(|_| "File is not valid UTF-8 — open it in the terminal instead".into())
    })
    .await
}

const IMAGE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Read a file as base64 — used to show images inline in the editor as a data
/// URL (the editor renders them like VS Code instead of failing as "binary").
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    blocking(move || {
        use base64::Engine as _;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > IMAGE_MAX_BYTES {
            return Err(format!(
                "Image is too large to preview ({:.1} MB)",
                meta.len() as f64 / (1024.0 * 1024.0)
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
}

/// Download an http(s) link to the user's Downloads folder, naming the file from
/// the server (Content-Disposition) or the URL. Returns the saved path. Uses the
/// system `curl` so no extra HTTP/TLS dependency is pulled in.
#[tauri::command]
async fn download_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    use tauri::Manager;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links can be downloaded".into());
    }
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("No Downloads folder: {e}"))?;
    let dir = downloads.to_string_lossy().into_owned();
    blocking(move || {
        std::fs::create_dir_all(&dir).ok();
        // -f fail on HTTP errors, -L follow redirects, -O remote name, -J honor
        // Content-Disposition; -w prints the path actually written.
        let output = std::process::Command::new("curl")
            .args([
                "-fLOJ",
                "--no-progress-meter",
                "--output-dir",
                &dir,
                "-w",
                "%{filename_effective}",
                &url,
            ])
            .output()
            .map_err(|e| format!("Could not run curl: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let msg = err.trim();
            return Err(if msg.is_empty() {
                "Download failed".into()
            } else {
                format!("Download failed: {msg}")
            });
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Err("Download produced no file (link has no filename?)".into());
        }
        Ok(path)
    })
    .await
}

/// Write editor contents back to disk atomically: write to a temp file in the
/// same directory, fsync, then rename over the target. A crash or full disk
/// mid-save leaves the original intact instead of a truncated file.
#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    blocking(move || {
        use std::io::Write as _;
        let target = std::path::Path::new(&path);
        let dir = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or("Invalid path")?;
        let name = target.file_name().ok_or("Invalid path")?.to_string_lossy();
        let tmp = dir.join(format!(".{name}.jterm-save"));
        let result = (|| {
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, target).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    })
    .await
}

/// Save a photo/screenshot from the clipboard to a temp PNG so its path can be
/// pasted into the shell. Returns `None` when the clipboard holds no image.
#[tauri::command]
async fn save_clipboard_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let image = match app.clipboard().read_image() {
        Ok(img) => img,
        Err(_) => return Ok(None), // no image on the clipboard
    };
    let (width, height) = (image.width(), image.height());
    let rgba = image.rgba().to_vec();
    blocking(move || {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let path = std::env::temp_dir().join(format!("jterm-paste-{stamp}.png"));
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

/// File paths currently on the clipboard. When an image (or any file) is copied
/// in Finder, macOS puts a *file reference* on the pasteboard plus the file's
/// name as plain text — not raw image bytes — so `save_clipboard_image` finds
/// nothing and a naive text paste yields just the bare filename. Reading the
/// file URL lets us paste the real path instead. Empty off macOS / when none.
#[tauri::command]
fn clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        read_clipboard_file_paths()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_file_paths() -> Vec<String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSString, NSURL};

    let mut out = Vec::new();
    let pb = NSPasteboard::generalPasteboard();
    // "public.file-url" is the modern UTI for a single file reference; it
    // decodes (e.g. %20 -> space) once routed through NSURL.path.
    let ty = NSString::from_str("public.file-url");
    if let Some(s) = pb.stringForType(&ty) {
        if let Some(url) = NSURL::URLWithString(&s) {
            if let Some(path) = url.path() {
                out.push(path.to_string());
            }
        }
    }
    out
}

/// Current working directory of a pane's shell (for the project toolbar/sidebar).
#[tauri::command]
async fn pane_cwd(state: State<'_, PtyManager>, id: u32) -> Result<Option<String>, String> {
    match state.pid(id) {
        Some(pid) => tauri::async_runtime::spawn_blocking(move || pty::process_cwd(pid))
            .await
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// A file in the project, for the ⌘P quick-open picker.
#[derive(Serialize)]
struct FileEntry {
    /// Path relative to the project root (what the user sees / fuzzy-matches).
    rel: String,
    /// Absolute path used to open the file.
    path: String,
}

const LIST_MAX_FILES: usize = 20000;

/// The project root for `path`, so file/text search covers the whole project
/// regardless of which subdirectory the terminal is in. Prefers the git
/// top-level; otherwise walks up to the nearest ancestor holding a common
/// project marker; otherwise returns `path` itself.
fn resolve_project_root(path: &str) -> String {
    if let Ok(out) = run_git(path, &["rev-parse", "--show-toplevel"]) {
        let top = out.trim();
        if !top.is_empty() {
            return top.to_string();
        }
    }
    const MARKERS: &[&str] = &[
        ".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml",
        "pom.xml", "build.gradle", "composer.json", ".hg", ".svn", "Makefile",
    ];
    let home = std::env::var("HOME").ok();
    let mut dir = std::path::Path::new(path);
    loop {
        if MARKERS.iter().any(|m| dir.join(m).exists()) {
            return dir.to_string_lossy().into_owned();
        }
        if home.as_deref() == dir.to_str() {
            break; // don't escape past the home directory
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent,
            _ => break,
        }
    }
    path.to_string()
}

/// Every file under `root`, skipping hidden and heavy build/vendor directories
/// (the same set the workspace search ignores). Sorted by relative path. Used by
/// the quick-open picker; capped so a giant tree can't stall the UI.
#[tauri::command]
async fn list_files(root: String) -> Result<Vec<FileEntry>, String> {
    blocking(move || {
        let root = std::path::PathBuf::from(resolve_project_root(&root));
        let mut out: Vec<FileEntry> = Vec::new();
        let mut stack = vec![root.clone()];
        'walk: while let Some(dir) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.filter_map(|e| e.ok()) {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let file_type = match entry.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    if !SKIP_DIRS.contains(&name.as_ref()) {
                        stack.push(entry.path());
                    }
                } else if file_type.is_file() {
                    let p = entry.path();
                    let rel = p
                        .strip_prefix(&root)
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push(FileEntry {
                        rel,
                        path: p.to_string_lossy().into_owned(),
                    });
                    if out.len() >= LIST_MAX_FILES {
                        break 'walk;
                    }
                }
            }
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    })
    .await
}

// ---- Full-text search -------------------------------------------------------

/// Directories never descended into when listing/searching the project. Only
/// dependency and cache/build-cache dirs are skipped — NOT `dist`/`build` output
/// or hidden config dirs (`.github`, `.claude`, …), so a project's own files
/// (even gitignored ones) still show up, like a file finder should.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "target",
    "vendor",
    "venv",
    ".venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".gradle",
    ".terraform",
    "Pods",
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
        matches.push(SearchMatch {
            line: (lineno + 1) as u32,
            text: snippet,
        });
        if matches.len() >= SEARCH_MAX_PER_FILE {
            break;
        }
    }
    matches
}

/// Run the (blocking) recursive search, bailing as soon as a newer search has
/// superseded `my_gen`. Enumerates candidate files (skipping hidden + build/
/// vendor dirs), then scans their contents across all cores.
fn search_blocking(path: &str, needle: &str, generation: &AtomicU64, my_gen: u64) -> SearchResults {
    let empty = || SearchResults {
        results: vec![],
        truncated: false,
    };
    let superseded = || generation.load(Ordering::Relaxed) != my_gen;
    // Search the whole repo, not just the terminal's current subdirectory.
    let root = std::path::PathBuf::from(resolve_project_root(path));

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
            if checked.is_multiple_of(512) && superseded() {
                return empty();
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !SKIP_DIRS.contains(&name.as_ref()) {
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
                let result = FileResult {
                    path: p.to_string_lossy().into_owned(),
                    rel,
                    matches,
                };
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
    results.sort_by_key(|a| a.rel.to_lowercase());
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
        return Ok(SearchResults {
            results: vec![],
            truncated: false,
        });
    }
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        search_blocking(&path, &needle, &generation, my_gen)
    })
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

/// Locate the GitHub CLI. An app launched from Finder inherits a minimal PATH
/// that usually omits Homebrew, so fall back to the common install locations.
fn find_gh() -> Option<String> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("gh");
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    for cand in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
        if std::path::Path::new(cand).is_file() {
            return Some(cand.to_string());
        }
    }
    None
}

/// Run a `gh` subcommand in `cwd`. Errors carry gh's own stderr (e.g. the
/// "run `gh auth login`" hint) so the panel can show something actionable.
fn run_gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let gh = find_gh().ok_or_else(|| {
        "GitHub CLI (gh) was not found. Install it from https://cli.github.com, \
         then run `gh auth login`."
            .to_string()
    })?;
    let out = std::process::Command::new(gh)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
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

/// Parse `git status --porcelain=v1 --branch -z` output into branch info and
/// per-file status records. Pure so it can be unit-tested without a repo.
fn parse_porcelain_status(raw: &str) -> (String, Option<String>, u32, u32, Vec<GitFile>) {
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
            // A rename/copy in either column is followed by an extra
            // NUL-terminated record holding the origin path.
            let is_rename = x == "R" || x == "C" || y == "R" || y == "C";
            files.push(GitFile {
                path: p.to_string(),
                x: x.to_string(),
                y: y.to_string(),
            });
            if is_rename {
                i += 1; // skip the rename source path that follows
            }
        }
        i += 1;
    }

    (branch, upstream, ahead, behind, files)
}

/// Porcelain status + branch/ahead/behind for the Source Control panel.
#[tauri::command]
async fn git_status(path: String) -> Result<GitStatus, String> {
    blocking(move || {
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

        let root = run_git(&path, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_string();
        let raw = run_git(
            &path,
            &["status", "--porcelain=v1", "--branch", "-uall", "-z"],
        )?;
        let (branch, upstream, ahead, behind, files) = parse_porcelain_status(&raw);
        Ok(GitStatus {
            is_repo: true,
            root,
            branch,
            upstream,
            ahead,
            behind,
            files,
        })
    })
    .await
}

#[tauri::command]
async fn git_stage(path: String, file: String) -> Result<(), String> {
    blocking(move || run_git(&path, &["add", "--", &file]).map(|_| ())).await
}

#[tauri::command]
async fn git_stage_all(path: String) -> Result<(), String> {
    blocking(move || run_git(&path, &["add", "-A"]).map(|_| ())).await
}

#[tauri::command]
async fn git_unstage(path: String, file: String) -> Result<(), String> {
    blocking(move || run_git(&path, &["reset", "-q", "HEAD", "--", &file]).map(|_| ())).await
}

#[tauri::command]
async fn git_unstage_all(path: String) -> Result<(), String> {
    blocking(move || run_git(&path, &["reset", "-q", "HEAD"]).map(|_| ())).await
}

#[tauri::command]
async fn git_discard_all(path: String) -> Result<(), String> {
    blocking(move || {
        // Revert tracked changes in the working tree, then remove untracked
        // files/dirs (respecting .gitignore) — VS Code's "Discard All Changes".
        let _ = run_git(&path, &["checkout", "--", "."]);
        run_git(&path, &["clean", "-fd"]).map(|_| ())
    })
    .await
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".into());
    }
    blocking(move || run_git(&path, &["commit", "-m", &message])).await
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    blocking(move || run_git(&path, &["push"])).await
}

#[tauri::command]
async fn git_discard(path: String, file: String) -> Result<(), String> {
    blocking(move || {
        // Fully revert the file regardless of its staged state, so it leaves the
        // changes list entirely (matching VS Code's Discard): unstage it first,
        // then restore it from HEAD; a brand-new file (no HEAD version) is deleted.
        let _ = run_git(&path, &["reset", "-q", "HEAD", "--", &file]);
        match run_git(&path, &["checkout", "--", &file]) {
            Ok(_) => Ok(()),
            Err(_) => {
                let full = std::path::Path::new(&path).join(&file);
                std::fs::remove_file(&full)
                    .or_else(|_| std::fs::remove_dir_all(&full))
                    .map_err(|e| format!("failed to discard: {e}"))
            }
        }
    })
    .await
}

#[tauri::command]
async fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    blocking(move || {
        if staged {
            run_git(&path, &["diff", "--staged", "--no-color", "--", &file])
        } else {
            run_git(&path, &["diff", "--no-color", "--", &file])
        }
    })
    .await
}

#[tauri::command]
async fn git_init(path: String) -> Result<String, String> {
    blocking(move || run_git(&path, &["init"])).await
}

/// Publish a local repo with no remote to a brand-new GitHub repository and push
/// the current branch — the VS Code "Publish Branch" flow. `private` chooses the
/// visibility. Uses the GitHub CLI for repo creation and auth.
#[tauri::command]
async fn git_publish(path: String, name: String, private: bool) -> Result<String, String> {
    blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("Repository name is empty".into());
        }
        // gh pushes the current branch, so there must be a commit to push.
        if run_git(&path, &["rev-parse", "--verify", "HEAD"]).is_err() {
            return Err("Nothing to publish yet — make your first commit, then publish.".into());
        }
        // If a remote is already configured, the branch just needs pushing with
        // upstream tracking — creating a new GitHub repo would fail on the
        // existing remote, so push instead.
        let remotes = run_git(&path, &["remote"]).unwrap_or_default();
        if let Some(remote) = remotes.split_whitespace().next() {
            let branch = run_git(&path, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_default();
            let branch = branch.trim();
            if branch.is_empty() {
                return Err("Could not determine the current branch.".into());
            }
            run_git(&path, &["push", "-u", remote, branch])?;
        } else {
            let visibility = if private { "--private" } else { "--public" };
            // Creates the GitHub repo, wires up `origin`, and pushes the branch.
            run_gh(
                &path,
                &[
                    "repo", "create", name, visibility,
                    "--source", &path, "--remote", "origin", "--push",
                ],
            )?;
        }
        // Best-effort: hand back the repo's web URL so the UI can link to it.
        // An empty string just means "published, link unknown".
        Ok(run_gh(&path, &["repo", "view", "--json", "url", "--jq", ".url"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default())
    })
    .await
}

/// Spawn a shell in a new PTY; returns the pty id used by the other commands.
#[tauri::command]
async fn pty_spawn(
    state: State<'_, PtyManager>,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    state.spawn(cwd, shell, cols, rows, on_event)
}

/// Forward input (keystrokes, pasted text) to a shell. The write happens on a
/// blocking-pool thread with only the per-session writer locked, so a pane
/// whose program stopped reading stdin can't stall the UI or other panes.
#[tauri::command]
async fn pty_write(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    use std::io::Write as _;
    let writer = state.writer(id)?;
    blocking(move || {
        let mut w = writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
}

/// Resize a PTY when its pane changes size.
#[tauri::command]
async fn pty_resize(
    state: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(id, cols, rows)
}

/// Kill a shell when its pane is closed.
#[tauri::command]
async fn pty_kill(state: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    state.kill(id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyManager::default())
        .manage(SearchState::default())
        // Remove most of the default macOS menu to prevent system accelerators
        // (Cmd+M minimize, Cmd+D bookmark, Cmd+H hide, etc.) from swallowing
        // keystrokes before the webview can handle them. Keep the app submenu
        // with Quit so Cmd+Q still closes the application.
        .menu(|handle| {
            let quit = PredefinedMenuItem::quit(handle, Some("Quit jterm"))?;
            let app_menu = SubmenuBuilder::new(handle, "jterm")
                .item(&quit)
                .build()?;
            let menu = Menu::with_items(handle, &[&app_menu])?;
            Ok(menu)
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            read_file_base64,
            download_url,
            write_file,
            pane_cwd,
            save_clipboard_image,
            clipboard_file_paths,
            list_files,
            search_in_folder,
            git_status,
            git_stage,
            git_stage_all,
            git_unstage,
            git_unstage_all,
            git_discard,
            git_discard_all,
            git_diff,
            git_commit,
            git_push,
            git_init,
            git_publish
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- ascii_ci_contains ----------------------------------------------------

    #[test]
    fn ci_contains_matches_case_insensitively() {
        assert!(ascii_ci_contains(b"Hello World", b"world"));
        assert!(ascii_ci_contains(b"HELLO", b"hello"));
        assert!(ascii_ci_contains(b"abc", b"abc"));
    }

    #[test]
    fn ci_contains_handles_empty_and_oversized_needles() {
        assert!(ascii_ci_contains(b"anything", b""));
        assert!(ascii_ci_contains(b"", b""));
        assert!(!ascii_ci_contains(b"ab", b"abc"));
        assert!(!ascii_ci_contains(b"", b"a"));
    }

    #[test]
    fn ci_contains_survives_repeated_prefixes() {
        // First bytes match repeatedly before the real hit.
        assert!(ascii_ci_contains(b"aaab", b"aab"));
        assert!(!ascii_ci_contains(b"aaa", b"aab"));
    }

    // -- extract_count ----------------------------------------------------------

    #[test]
    fn extract_count_reads_ahead_and_behind() {
        assert_eq!(extract_count("[ahead 3]", "ahead"), 3);
        assert_eq!(extract_count("[ahead 2, behind 15]", "behind"), 15);
        assert_eq!(extract_count("[behind 7]", "ahead"), 0);
        assert_eq!(extract_count("", "ahead"), 0);
    }

    // -- parse_porcelain_status ---------------------------------------------------

    #[test]
    fn parses_branch_with_upstream_and_counts() {
        let raw = "## main...origin/main [ahead 1, behind 2]\0M  a.rs\0 M b.txt\0?? new file.txt\0";
        let (branch, upstream, ahead, behind, files) = parse_porcelain_status(raw);
        assert_eq!(branch, "main");
        assert_eq!(upstream.as_deref(), Some("origin/main"));
        assert_eq!(ahead, 1);
        assert_eq!(behind, 2);
        assert_eq!(files.len(), 3);
        assert_eq!(
            (
                files[0].x.as_str(),
                files[0].y.as_str(),
                files[0].path.as_str()
            ),
            ("M", " ", "a.rs")
        );
        assert_eq!((files[1].x.as_str(), files[1].y.as_str()), (" ", "M"));
        // Paths with spaces survive the -z record split.
        assert_eq!(files[2].path, "new file.txt");
    }

    #[test]
    fn parses_branch_without_upstream_and_empty_repo() {
        let (branch, upstream, ..) = parse_porcelain_status("## feature/x\0");
        assert_eq!(branch, "feature/x");
        assert_eq!(upstream, None);

        let (branch, ..) = parse_porcelain_status("## No commits yet on main\0");
        assert_eq!(branch, "main");
    }

    #[test]
    fn index_rename_skips_origin_path_record() {
        let raw = "## main\0R  new-name.rs\0old-name.rs\0M  other.rs\0";
        let (.., files) = parse_porcelain_status(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new-name.rs");
        assert_eq!(files[1].path, "other.rs");
    }

    #[test]
    fn worktree_rename_also_skips_origin_path_record() {
        // ` R` (rename in the work tree, e.g. after `git add -N`) also carries an
        // origin-path record; treating it as a plain entry would inject a phantom
        // file whose "status" is the first bytes of the origin path.
        let raw = "## main\0 R renamed.rs\0origin.rs\0M  real.rs\0";
        let (.., files) = parse_porcelain_status(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "renamed.rs");
        assert_eq!((files[0].x.as_str(), files[0].y.as_str()), (" ", "R"));
        assert_eq!(files[1].path, "real.rs");
    }
}
