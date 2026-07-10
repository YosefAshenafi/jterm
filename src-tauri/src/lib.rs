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

/// Create an empty file at `path`, making any missing parent directories first
/// (so "src/utils/new.ts" works like VS Code). Refuses to clobber an existing
/// file or folder so a "New File" never silently destroys one.
#[tauri::command]
async fn create_file(path: String) -> Result<(), String> {
    blocking(move || {
        let target = std::path::Path::new(&path);
        if target.exists() {
            return Err(format!("“{}” already exists", display_name(target, &path)));
        }
        if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // `create_new` fails if the path appeared between the check above and
        // here, closing the last gap against clobbering a file.
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

/// Create a directory at `path`, making any missing parents. Refuses to clobber
/// an existing file or folder.
#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    blocking(move || {
        let target = std::path::Path::new(&path);
        if target.exists() {
            return Err(format!("“{}” already exists", display_name(target, &path)));
        }
        std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

/// Delete a file or directory (folders are removed recursively). Backs the
/// explorer's Delete action; the confirmation prompt lives in the UI.
#[tauri::command]
async fn delete_entry(path: String) -> Result<(), String> {
    blocking(move || {
        let target = std::path::Path::new(&path);
        // `symlink_metadata` so a symlink to a folder is unlinked, not recursed
        // into and emptied.
        let meta = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            std::fs::remove_dir_all(target).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(target).map_err(|e| e.to_string())
        }
    })
    .await
}

/// Rename a file or directory in place to `new_name`, returning the new path.
/// The name must be a single path segment — Rename never moves an entry.
/// Refuses to clobber a different existing entry, but allows case-only renames
/// (on macOS's case-insensitive filesystem the target "exists" — it's the
/// source itself, which canonical paths tell apart from a real collision).
fn rename_path(path: &str, new_name: &str) -> Result<String, String> {
    let source = std::path::Path::new(path);
    let name = new_name.trim();
    if name.is_empty() {
        return Err("Name can't be empty".into());
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(format!("“{name}” is not a valid name"));
    }
    std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    let target = source
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("Can't rename the filesystem root")?
        .join(name);
    if target == source {
        return Ok(path.to_string());
    }
    if target.exists() && std::fs::canonicalize(&target).ok() != std::fs::canonicalize(source).ok()
    {
        return Err(format!("“{name}” already exists"));
    }
    std::fs::rename(source, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Rename a file or directory in place (same parent, new name), returning the
/// new path. Backs the explorer's Rename action.
#[tauri::command]
async fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    blocking(move || rename_path(&path, &new_name)).await
}

/// The final path segment for an error message, falling back to the raw input.
fn display_name(target: &std::path::Path, raw: &str) -> String {
    target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string())
}

/// Pick a non-existing path in `dir` for `name`, inserting " copy", " copy 2", …
/// before the extension when something is already there — the Finder
/// paste-into-the-same-folder behaviour, so a paste never overwrites a file.
fn unique_target(dir: &std::path::Path, name: &std::ffi::OsStr) -> std::path::PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    let name = std::path::Path::new(name);
    // `file_stem`/`extension` keep dotfiles intact: ".gitignore" has no
    // extension, so it becomes ".gitignore copy" rather than "copy.gitignore".
    let stem = name
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = name.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 1.. {
        let suffix = if n == 1 {
            " copy".to_string()
        } else {
            format!(" copy {n}")
        };
        let fname = match &ext {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = dir.join(fname);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("the loop above only ends by returning")
}

/// Recursively copy a directory tree from `src` into the new directory `dest`.
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy files and/or folders into `dest_dir`, returning the created paths. Backs
/// the explorer's Copy → Paste: each source keeps its name, gaining a " copy"
/// suffix only when the destination already has that name, so a paste is never
/// destructive. Pasting a folder into itself or one of its descendants is
/// refused (it would recurse forever).
#[tauri::command]
async fn copy_entries(sources: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let dest = std::path::Path::new(&dest_dir);
        if !dest.is_dir() {
            return Err("Destination is not a folder".into());
        }
        let canon_dest = std::fs::canonicalize(dest).map_err(|e| e.to_string())?;
        let mut created = Vec::new();
        for src in &sources {
            let src_path = std::path::Path::new(src);
            let meta = std::fs::symlink_metadata(src_path).map_err(|e| format!("{src}: {e}"))?;
            let name = src_path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {src}"))?;
            if meta.is_dir() {
                let canon_src = std::fs::canonicalize(src_path).map_err(|e| e.to_string())?;
                if canon_dest == canon_src || canon_dest.starts_with(&canon_src) {
                    return Err(format!(
                        "Can't paste “{}” into itself",
                        name.to_string_lossy()
                    ));
                }
            }
            let target = unique_target(dest, name);
            if meta.is_dir() {
                copy_dir_recursive(src_path, &target)?;
            } else {
                std::fs::copy(src_path, &target).map_err(|e| format!("{src}: {e}"))?;
            }
            created.push(target.to_string_lossy().into_owned());
        }
        Ok(created)
    })
    .await
}

/// Move files and/or folders into `dest_dir`, returning the new paths. Backs the
/// explorer's drag-and-drop: `rename` on the same filesystem (fast), falling back
/// to copy+delete for cross-device moves. Refuses to move into itself.
#[tauri::command]
async fn move_entries(sources: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let dest = std::path::Path::new(&dest_dir);
        if !dest.is_dir() {
            return Err("Destination is not a folder".into());
        }
        let canon_dest = std::fs::canonicalize(dest).map_err(|e| e.to_string())?;
        let mut moved = Vec::new();
        for src in &sources {
            let src_path = std::path::Path::new(src);
            let meta = std::fs::symlink_metadata(src_path).map_err(|e| format!("{src}: {e}"))?;
            let name = src_path
                .file_name()
                .ok_or_else(|| format!("Invalid path: {src}"))?;
            if meta.is_dir() {
                let canon_src = std::fs::canonicalize(src_path).map_err(|e| e.to_string())?;
                if canon_dest == canon_src || canon_dest.starts_with(&canon_src) {
                    return Err(format!(
                        "Can't move “{}” into itself",
                        name.to_string_lossy()
                    ));
                }
            }
            let target = unique_target(dest, name);
            if std::fs::rename(src_path, &target).is_err() {
                // Cross-device move: fall back to copy + delete.
                if meta.is_dir() {
                    copy_dir_recursive(src_path, &target)?;
                    std::fs::remove_dir_all(src_path).map_err(|e| e.to_string())?;
                } else {
                    std::fs::copy(src_path, &target).map_err(|e| format!("{src}: {e}"))?;
                    std::fs::remove_file(src_path).map_err(|e| e.to_string())?;
                }
            }
            moved.push(target.to_string_lossy().into_owned());
        }
        Ok(moved)
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
        Err(_) => return Ok(None),
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

/// Monotonic id of the system clipboard's current contents — it advances every
/// time any app writes to the clipboard. The explorer records it at "Copy" time
/// so Paste can tell whether the OS clipboard was updated *after* that in-app
/// Copy (a Finder copy since then), and prefer whichever is more recent. Returns
/// 0 off macOS, where there's no such counter and the in-app copy simply wins.
#[tauri::command]
fn clipboard_change_count() -> i64 {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSPasteboard;
        NSPasteboard::generalPasteboard().changeCount() as i64
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_file_paths() -> Vec<String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSString, NSURL};

    let url_to_path = |s: &NSString| {
        NSURL::URLWithString(s)
            .and_then(|url| url.path())
            .map(|p| p.to_string())
    };

    let mut out = Vec::new();
    let pb = NSPasteboard::generalPasteboard();
    let ty = NSString::from_str("public.file-url");
    // Finder copies several files as one pasteboard item per file, each carrying
    // its own file URL — iterate them so "copy 3 files" yields all three paths,
    // not just the first (the explorer's Paste then pastes every one).
    if let Some(items) = pb.pasteboardItems() {
        for item in items.iter() {
            if let Some(path) = item.stringForType(&ty).and_then(|s| url_to_path(&s)) {
                out.push(path);
            }
        }
    }
    // Fall back to the combined file URL when no per-item URL was present.
    if out.is_empty() {
        if let Some(path) = pb.stringForType(&ty).and_then(|s| url_to_path(&s)) {
            out.push(path);
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
        ".git",
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "pom.xml",
        "build.gradle",
        "composer.json",
        ".hg",
        ".svn",
        "Makefile",
    ];
    let home = std::env::var("HOME").ok();
    let mut dir = std::path::Path::new(path);
    loop {
        if MARKERS.iter().any(|m| dir.join(m).exists()) {
            return dir.to_string_lossy().into_owned();
        }
        if home.as_deref() == dir.to_str() {
            break;
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
        return Vec::new();
    }
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
    let root = std::path::PathBuf::from(resolve_project_root(path));

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

/// Map a finished process's output to stdout on success, or stderr (falling back
/// to stdout when stderr is empty) on failure.
fn command_output(out: std::process::Output) -> Result<String, String> {
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

/// Run a git subcommand in `cwd`, returning stdout on success or stderr on error.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    command_output(out)
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
    command_output(out)
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
            let is_rename = x == "R" || x == "C" || y == "R" || y == "C";
            files.push(GitFile {
                path: p.to_string(),
                x: x.to_string(),
                y: y.to_string(),
            });
            if is_rename {
                i += 1;
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
        if run_git(&path, &["rev-parse", "--verify", "HEAD"]).is_err() {
            return Err("Nothing to publish yet — make your first commit, then publish.".into());
        }
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
            run_gh(
                &path,
                &[
                    "repo", "create", name, visibility, "--source", &path, "--remote", "origin",
                    "--push",
                ],
            )?;
        }
        Ok(
            run_gh(&path, &["repo", "view", "--json", "url", "--jq", ".url"])
                .map(|s| s.trim().to_string())
                .unwrap_or_default(),
        )
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
        .menu(|handle| {
            let quit = PredefinedMenuItem::quit(handle, Some("Quit jterm"))?;
            let app_menu = SubmenuBuilder::new(handle, "jterm").item(&quit).build()?;
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
            create_file,
            create_dir,
            delete_entry,
            rename_entry,
            copy_entries,
            move_entries,
            pane_cwd,
            save_clipboard_image,
            clipboard_file_paths,
            clipboard_change_count,
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
        assert!(ascii_ci_contains(b"aaab", b"aab"));
        assert!(!ascii_ci_contains(b"aaa", b"aab"));
    }

    #[test]
    fn extract_count_reads_ahead_and_behind() {
        assert_eq!(extract_count("[ahead 3]", "ahead"), 3);
        assert_eq!(extract_count("[ahead 2, behind 15]", "behind"), 15);
        assert_eq!(extract_count("[behind 7]", "ahead"), 0);
        assert_eq!(extract_count("", "ahead"), 0);
    }

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
        let raw = "## main\0 R renamed.rs\0origin.rs\0M  real.rs\0";
        let (.., files) = parse_porcelain_status(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "renamed.rs");
        assert_eq!((files[0].x.as_str(), files[0].y.as_str()), (" ", "R"));
        assert_eq!(files[1].path, "real.rs");
    }

    use std::ffi::OsStr;

    /// Fresh, empty temp dir unique to one test (so parallel tests don't clash).
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jterm-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unique_target_uses_the_name_when_free() {
        let dir = scratch("unique-free");
        assert_eq!(unique_target(&dir, OsStr::new("a.txt")), dir.join("a.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unique_target_suffixes_before_the_extension() {
        let dir = scratch("unique-ext");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert_eq!(
            unique_target(&dir, OsStr::new("a.txt")),
            dir.join("a copy.txt")
        );
        std::fs::write(dir.join("a copy.txt"), b"x").unwrap();
        assert_eq!(
            unique_target(&dir, OsStr::new("a.txt")),
            dir.join("a copy 2.txt")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unique_target_keeps_dotfiles_and_extensionless_names_intact() {
        let dir = scratch("unique-dot");
        std::fs::write(dir.join(".gitignore"), b"x").unwrap();
        assert_eq!(
            unique_target(&dir, OsStr::new(".gitignore")),
            dir.join(".gitignore copy")
        );
        std::fs::write(dir.join("README"), b"x").unwrap();
        assert_eq!(
            unique_target(&dir, OsStr::new("README")),
            dir.join("README copy")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_path_renames_files_and_folders() {
        let dir = scratch("rename-basic");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let new = rename_path(&dir.join("a.txt").to_string_lossy(), "b.txt").unwrap();
        assert_eq!(new, dir.join("b.txt").to_string_lossy());
        assert!(!dir.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "x");

        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("inner.txt"), b"y").unwrap();
        let new = rename_path(&dir.join("sub").to_string_lossy(), "renamed").unwrap();
        assert_eq!(new, dir.join("renamed").to_string_lossy());
        assert!(std::path::Path::new(&new).join("inner.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_path_same_name_is_a_no_op_and_case_only_renames_work() {
        let dir = scratch("rename-case");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        let a = dir.join("a.txt").to_string_lossy().into_owned();
        assert_eq!(rename_path(&a, "a.txt").unwrap(), a);
        let new = rename_path(&a, "A.txt").unwrap();
        assert_eq!(new, dir.join("A.txt").to_string_lossy());
        assert_eq!(std::fs::read_to_string(dir.join("A.txt")).unwrap(), "x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_path_refuses_collisions_and_bad_names() {
        let dir = scratch("rename-guard");
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        std::fs::write(dir.join("b.txt"), b"b").unwrap();
        let a = dir.join("a.txt").to_string_lossy().into_owned();
        assert!(rename_path(&a, "b.txt").is_err());
        assert!(rename_path(&a, "").is_err());
        assert!(rename_path(&a, "  ").is_err());
        assert!(rename_path(&a, "x/y.txt").is_err());
        assert!(rename_path(&a, "..").is_err());
        assert!(rename_path(&dir.join("missing.txt").to_string_lossy(), "c.txt").is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copy_dir_recursive_copies_the_whole_tree() {
        let base = scratch("copydir");
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), b"world").unwrap();
        let dest = base.join("dest");
        copy_dir_recursive(&src, &dest).unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("a.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("sub").join("b.txt")).unwrap(),
            "world"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
