import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Render a divider above this item, grouping it apart from the previous one. */
  separator?: boolean;
  /** Destructive action (e.g. Delete) — rendered in a warning colour. */
  danger?: boolean;
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

  // Portal to <body> so the menu isn't trapped by a transformed ancestor (e.g.
  // the peeked sidebar or the full-screen shell), which would otherwise make
  // `position: fixed` resolve against that ancestor and offset it from the cursor.
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={pos}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <Fragment key={i}>
          {item.separator && i > 0 && <div className="context-separator" />}
          <button
            className={`context-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
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
        </Fragment>
      ))}
    </div>,
    document.body
  );
}
