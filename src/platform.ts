// Platform detection. Keyboard chords and a few behaviours differ on macOS
// (⌘ vs Ctrl), so this is shared rather than re-derived per module.
export const isMac =
  /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
