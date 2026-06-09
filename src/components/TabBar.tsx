import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

/** Top tab strip: click to switch, double-click a title to rename, × to close,
 * + to open a new tab. */
export function TabBar() {
  const { state, selectTab, closeTab, newTab, renameTab } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the field whenever we enter edit mode.
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
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabs" role="tablist">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === state.activeTabId}
            className={`tab${tab.id === state.activeTabId ? " tab-active" : ""}`}
            // Select on pointerdown (not click) so switching feels instant,
            // like native tab strips — but only for the primary button.
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              selectTab(tab.id);
            }}
            onKeyDown={(e) => {
              // Only when the tab itself is focused — keys from the close
              // button or rename input must not also switch tabs.
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
              // preventDefault on pointerdown keeps focus in the terminal;
              // closing happens on click so keyboard activation works.
              // stopPropagation in both handlers so the parent tab never
              // selects when closing.
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
        ))}
      </div>
      <button
        className="tab-new"
        aria-label="New tab"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => newTab()}
      >
        +
      </button>
    </div>
  );
}
