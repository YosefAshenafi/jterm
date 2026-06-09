# Security Policy

## Supported versions

jterm is pre-1.0 and ships from `main`. Security fixes land on `main` and in the
next tagged release. The most recent release is the only supported version.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[security advisory form](https://github.com/yosefashenafi/jterm/security/advisories/new).
If you cannot use GitHub advisories, contact the maintainer directly.
<!-- TODO: add a contact email here once you have a public one. -->

Please include:

- a description of the vulnerability and its impact,
- the steps or a proof-of-concept to reproduce it,
- the affected version or commit, and your OS.

You can expect an acknowledgement within a few days and a coordinated fix and
disclosure once the issue is confirmed.

## Trust model

jterm is a local desktop application. Understanding its trust boundaries helps
you judge what is and isn't a vulnerability:

- **It runs with your privileges.** A terminal exists to run programs as you, so
  any command typed into a pane runs with your full user permissions. That is by
  design, not a flaw.
- **No network listener.** jterm does not open a network port or run a server.
  The only IPC is the Tauri bridge between the local webview and the local Rust
  backend, scoped by the capability allowlist in
  [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json).
- **Filesystem access is local and explicit.** The editor reads/writes files you
  open, and refuses binaries and files over 8 MB. Search reads files under a
  folder you choose, skipping build/vendor/hidden directories and large files.
- **Git is shelled out to the system `git`.** Source Control commands run the
  `git` binary on your `PATH` in the selected folder. They inherit your git
  configuration and credentials, exactly as if you ran them yourself.

### Things we _do_ consider security issues

- Escaping the capability allowlist or invoking backend commands the UI never
  intended to expose.
- Path traversal or argument injection in the file, search, or git commands that
  lets a crafted folder/filename reach outside its intended scope.
- Memory-safety defects in the Rust backend.
- Any way for untrusted terminal output (escape sequences) to execute code or
  read files outside the terminal sandbox.

Thank you for helping keep jterm and its users safe.
