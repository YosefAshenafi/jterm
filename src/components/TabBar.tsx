import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { usePaneDnd } from "../state/paneDnd";

/** Top tab strip: click to switch, double-click a title to rename, × to close,
 * + to open a new tab. */
export function TabBar() {
  const { state, selectTab, closeTab, newTab, renameTab } = useStore();
  const dnd = usePaneDnd();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const dragging = dnd.draggingPaneId !== null;
  const newTabActive = dragging && dnd.dropTarget?.kind === "new-tab";

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startEdit = (tabId: string, current: string) => {
    setDraft(current);
    setEditingId(tabId);
  };

  const commit = () => {
    if (editingId) renameTab(editingId, draft);
    setEditingId(null);
  };

  const cancel = () => setEditingId(null);

  return (
    <div className={`tabbar${dragging ? " tabbar-droppable" : ""}`} data-tabbar>
      <div className="tabs" role="tablist">
        {state.tabs.map((tab) => {
          const dropTarget =
            dragging && dnd.dropTarget?.kind === "tab" && dnd.dropTarget.tabId === tab.id;
          return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            data-tab-id={tab.id}
            aria-selected={tab.id === state.activeTabId}
            className={`tab${tab.id === state.activeTabId ? " tab-active" : ""}${
              dropTarget ? " tab-drop-target" : ""
            }`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              selectTab(tab.id);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectTab(tab.id);
              }
            }}
            title={editingId === tab.id ? undefined : `${tab.title}  ·  double-click to rename`}
          >
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                className="tab-title-input"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  else if (e.key === "Escape") cancel();
                  e.stopPropagation();
                }}
              />
            ) : (
              <span className="tab-title" onDoubleClick={() => startEdit(tab.id, tab.title)}>
                {tab.title}
              </span>
            )}
            <button
              className="tab-close"
              aria-label="Close tab"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
          );
        })}
      </div>
      <button
        className={`tab-new${newTabActive ? " tab-new-droppable" : ""}`}
        aria-label={dragging ? "Drop here for a new tab" : "New tab"}
        title={dragging ? "Drop here to move this terminal into a new tab" : "New tab"}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => newTab()}
      >
        +
      </button>
    </div>
  );
}
