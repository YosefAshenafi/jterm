//! PTY management.
//!
//! Each pane in the UI owns one [`PtySession`] — a real pseudo-terminal running
//! the user's shell. A dedicated reader thread per session streams the shell's
//! raw output back to the frontend over a Tauri [`Channel`], base64-encoded so
//! that multi-byte UTF-8 sequences split across reads are reassembled by xterm.js
//! rather than corrupted in transit.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

/// The write half of a PTY. Shared (and locked per session, not globally) so a
/// write that blocks on a full PTY buffer — e.g. a large paste into a program
/// that stopped reading stdin — stalls only its own pane, never the whole app.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A single running shell behind a PTY.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: Box<dyn Child + Send + Sync>,
    /// OS pid of the shell, used to look up its current working directory.
    pid: Option<u32>,
}

/// Events streamed from a shell to the frontend over the per-session channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PtyEvent {
    /// Raw shell output, base64-encoded.
    Data { data: String },
    /// The shell process exited.
    Exit { code: i32 },
}

/// Owns every live PTY session, keyed by an id handed to the frontend.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
    /// Spawn a shell in a new PTY and start streaming its output.
    pub fn spawn(
        &self,
        cwd: Option<String>,
        shell: Option<String>,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
    ) -> Result<u32, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = shell.unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(shell);
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        // Start as a login shell so the user's shell profile / path_helper
        // (Homebrew, etc.) runs. Without this, commands like `docker compose`,
        // `ssh`, and any tool registered via /etc/paths.d go unfound.
        #[cfg(not(target_os = "windows"))]
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let pid = child.process_id();
        // Dropping the slave lets the master observe EOF when the child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        // Reader thread: pump shell output to the frontend until EOF.
        let channel = on_event.clone();
        thread::spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let encoded = engine.encode(&buf[..n]);
                        if channel.send(PtyEvent::Data { data: encoded }).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = channel.send(PtyEvent::Exit { code: 0 });
        });

        self.sessions.lock().unwrap().insert(
            id,
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                pid,
            },
        );
        Ok(id)
    }

    /// OS pid of a pane's shell, for cwd lookups.
    pub fn pid(&self, id: u32) -> Option<u32> {
        self.sessions.lock().unwrap().get(&id)?.pid
    }

    /// Handle for writing to a pane's shell. The caller does the actual write
    /// without the session map locked, so one blocked pane can't freeze others.
    pub fn writer(&self, id: u32) -> Result<SharedWriter, String> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .ok_or("no such pty")?
            .writer
            .clone())
    }

    /// Resize the PTY (fires SIGWINCH to the shell / TUI).
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no such pty")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Kill the shell and drop the session.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(&id) {
            let _ = session.child.kill();
        }
        Ok(())
    }
}

/// Resolve a process's current working directory via the OS process table.
/// Returns `None` if the process is gone or the platform won't report it.
/// Refreshes only the one process — a full `System::new_all()` enumerates every
/// process on the machine and costs tens of milliseconds per call.
pub fn process_cwd(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    let pid = Pid::from_u32(pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
    );
    let cwd = sys.process(pid)?.cwd()?;
    Some(cwd.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn default_shell() -> String {
    // Prefer PowerShell 7 (pwsh), then Windows PowerShell; cmd.exe only as a
    // last resort. COMSPEC points at cmd.exe on every Windows install, so
    // checking it first would mean nobody ever got PowerShell.
    let path = std::env::var_os("PATH").unwrap_or_default();
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if std::env::split_paths(&path).any(|dir| dir.join(candidate).is_file()) {
            return candidate.to_string();
        }
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}
