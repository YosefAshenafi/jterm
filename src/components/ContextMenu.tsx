import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Lightweight right-click menu, closed on any outside click or Escape. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport before paint: the app is overflow:hidden, so a
  // menu opened near the bottom/right edge (e.g. at the shell prompt) would
  // otherwise put items offscreen with no way to reach them.
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={pos}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="context-item"
          disabled={item.disabled}
          // Pointer activation must stay on pointerdown: the window-level
          // close listener runs before any click could be delivered. onClick
          // covers keyboard only — e.detail is 0 exactly when the click came
          // from Enter/Space rather than a pointer.
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (!item.disabled) {
              item.onClick();
              onClose();
            }
          }}
          onClick={(e) => {
            if (e.detail === 0 && !item.disabled) {
              item.onClick();
              onClose();
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
