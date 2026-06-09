import { useEffect, useRef, useState } from "react";
import { terminals } from "../terminal/manager";
import { MaximizeIcon, RestoreIcon } from "./icons";

interface Props {
  paneId: string;
  active: boolean;
  /** This pane is currently zoomed to fill the workspace. */
  zoomed: boolean;
  /** Whether a zoom toggle makes sense (tab has more than one pane). */
  canZoom: boolean;
  onFocus: () => void;
  onClose: () => void;
  onToggleZoom: () => void;
  onContextMenu: (x: number, y: number) => void;
}

// Size of the top-right "deliberate" zone that reveals the pane tools. They stay
// hidden everywhere else so they never pop up while you're just working.
const HOT_W = 96;
const HOT_H = 48;

/**
 * Hosts a single terminal. The xterm instance itself lives in the terminal
 * manager (keyed by paneId), so this component only mounts the element, keeps it
 * fitted to its box, and forwards focus / right-click intent to the store.
 */
export function TerminalPane({
  paneId,
  active,
  zoomed,
  canZoom,
  onFocus,
  onClose,
  onToggleZoom,
  onContextMenu,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [showTools, setShowTools] = useState(false);

  // Reveal the tools only when the pointer is near the active pane's top-right
  // corner. React bails out when the boolean is unchanged, so moving the mouse
  // around the rest of the terminal is cheap.
  const trackTools = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const inHot = e.clientX >= r.right - HOT_W && e.clientY <= r.top + HOT_H;
    setShowTools(inHot);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    terminals.attach(paneId, el);
    terminals.spawn(paneId);

    const ro = new ResizeObserver(() => terminals.fit(paneId));
    ro.observe(el);
    return () => ro.disconnect(); // never dispose here — the manager owns lifetime
  }, [paneId]);

  useEffect(() => {
    if (active) terminals.focus(paneId);
  }, [active, paneId]);

  return (
    <div
      className={`pane${active ? " pane-active" : ""}`}
      onPointerDownCapture={onFocus}
      onPointerMove={active ? trackTools : undefined}
      onPointerLeave={active ? () => setShowTools(false) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onFocus();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {/* xterm's DOM is appended here by the manager (kept outside React). */}
      <div ref={ref} className="terminal-mount" />

      {/* Pane tools: maximize/restore + close. Hidden until the pointer reaches
          the top-right corner (or one gains keyboard focus). ⌘M / ⌘W mirror them. */}
      {active && (
        <div className={`pane-tools${showTools ? " pane-tools-visible" : ""}`}>
          {canZoom && (
            <button
              className="pane-tool"
              aria-label={zoomed ? "Restore split" : "Maximize terminal"}
              title={zoomed ? "Restore split  ·  ⌘M" : "Maximize  ·  ⌘M"}
              // Swallow the press so the terminal keeps focus; the action runs
              // on click so keyboard Enter/Space still works.
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleZoom();
              }}
            >
              {zoomed ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
          )}
          <button
            className="pane-tool pane-tool-close"
            aria-label="Close terminal"
            title="Close terminal  ·  ⌘W"
            // Same focus-preserving press / click-activated pattern as above.
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
