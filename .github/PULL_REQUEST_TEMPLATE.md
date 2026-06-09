<!-- Thanks for contributing. Keep PRs focused; smaller is easier to review. -->

## What & why

<!-- What does this change, and what problem does it solve? Link any related issue. -->

Closes #

## How I tested

<!-- CI covers tests, build, and formatting. Note anything you checked by hand,
     and on which OS (macOS / Windows) and shell. -->

- [ ] `pnpm test:run` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm build` passes
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` is clean
- [ ] Verified the change by hand in `pnpm tauri dev`

## Notes

- [ ] Added a `CHANGELOG.md` entry under **Unreleased** (if user-facing)
- [ ] Kept the architecture invariants (terminals outside React, pure tree ops);
      see CONTRIBUTING
