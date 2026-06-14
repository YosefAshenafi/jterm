/**
 * Pointer-drag tracking for divider / resize handles. Naive window listeners
 * fail in ways that leave a "ghost drag" resizing on unpressed mouse movement:
 * pointercancel (trackpad gestures, OS interruptions) ends the press without a
 * pointerup ever firing; a release outside the window is never delivered unless
 * the pointer is captured; and a pointerup swallowed elsewhere leaves the
 * listeners installed forever. This helper covers all of those and returns its
 * own teardown so callers can also run it if they unmount mid-drag.
 */
export function trackPointerDrag(
  e: { pointerId: number; currentTarget: Element },
  onMove: (ev: PointerEvent) => void,
  onEnd?: () => void
): () => void {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
  }

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", teardown);
    window.removeEventListener("pointercancel", teardown);
    onEnd?.();
  };
  const handleMove = (ev: PointerEvent) => {
    if (ev.buttons === 0) {
      teardown();
      return;
    }
    onMove(ev);
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", teardown);
  window.addEventListener("pointercancel", teardown);
  return teardown;
}
