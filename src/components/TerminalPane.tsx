import { useEffect, useRef, useState } from "react";
import { terminals } from "../terminal/manager";
import { useStore } from "../state/store";
import {
  computeDropTarget,
  DropTarget,
  moveGhost,
  removeGhost,
  showGhost,
  usePaneDnd,
} from "../state/paneDnd";
import { trackPointerDrag } from "../drag";
import { MaximizeIcon, RestoreIcon } from "./icons";
import { basename, resolveCwd } from "../workspace";

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
  onContextMenu: (x: number, y: number, link?: string) => void;
  /** Called when the CWD resolves for the first pane in a tab. */
  onCwdChange?: (cwd: string) => void;
}

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
  onCwdChange,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [showTools, setShowTools] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const titleSet = useRef(false);
  const { movePane } = useStore();
  const dnd = usePaneDnd();
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const dropZone =
    dnd.dropTarget?.kind === "pane" && dnd.dropTarget.paneId === paneId
      ? dnd.dropTarget.zone
      : null;

  const startHeaderDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let target: DropTarget | null = null;
    trackPointerDrag(
      e,
      (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
          dragging = true;
          dnd.begin(paneId);
          document.body.classList.add("pane-dragging");
          showGhost(basename(cwdRef.current ?? "~"));
        }
        moveGhost(ev.clientX, ev.clientY);
        target = computeDropTarget(ev.clientX, ev.clientY, paneId);
        dnd.setDropTarget(target);
      },
      () => {
        if (!dragging) return;
        document.body.classList.remove("pane-dragging");
        removeGhost();
        dnd.end();
        if (target) movePane(paneId, target);
      }
    );
  };

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
    return () => ro.disconnect();
  }, [paneId]);

  useEffect(() => {
    if (active) terminals.focus(paneId);
  }, [active, paneId]);

  useEffect(() => {
    let cancelled = false;

    if (onCwdChangeRef.current) {
      if (titleSet.current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      const capture = async () => {
        const dir = await resolveCwd(paneId);
        if (cancelled) return;
        if (terminals.getPtyId(paneId) == null && attempts < 20) {
          attempts++;
          setCwd((prev) => prev ?? dir);
          timer = setTimeout(capture, 500);
          return;
        }
        titleSet.current = true;
        setCwd(dir);
        onCwdChangeRef.current?.(dir);
      };
      capture();
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }

    if (!active) return;
    const poll = async () => {
      const dir = await resolveCwd(paneId);
      if (!cancelled) setCwd(dir);
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [active, paneId]);

  return (
    <div
      className={`pane${active ? " pane-active" : ""}${
        dnd.draggingPaneId === paneId ? " pane-drag-source" : ""
      }`}
      data-pane-id={paneId}
      onPointerDownCapture={onFocus}
      onPointerMove={active ? trackTools : undefined}
      onPointerLeave={active ? () => setShowTools(false) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onFocus();
        onContextMenu(e.clientX, e.clientY, terminals.getHoveredLink() ?? undefined);
      }}
    >
      <div
        className="pane-header"
        title={`${basename(cwd ?? "~")}  ·  drag to move this terminal`}
        onPointerDown={startHeaderDrag}
      >
        {basename(cwd ?? "~")}
      </div>

      <div ref={ref} className="terminal-mount" />

      {dropZone && <div className={`pane-drop-overlay zone-${dropZone}`} />}

      {active && (
        <div className={`pane-tools${showTools ? " pane-tools-visible" : ""}`}>
          {canZoom && (
            <button
              className="pane-tool"
              aria-label={zoomed ? "Restore split" : "Maximize terminal"}
              title={zoomed ? "Restore split  ·  ⌘M" : "Maximize  ·  ⌘M"}
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
