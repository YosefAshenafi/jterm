import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useStore } from "../state/store";
import { firstLeaf } from "../state/tree";
import { basename, resolveCwd } from "../workspace";
import {
  FolderIcon,
  GearIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
} from "./icons";
import { SettingsDialog } from "./SettingsDialog";

/** Expand a leading `~` to the home directory; otherwise pass the path through. */
async function expandPath(raw: string): Promise<string> {
  if (raw === "~" || raw.startsWith("~/")) {
    const home = (await homeDir()).replace(/\/+$/, "");
    return raw === "~" ? home : `${home}/${raw.slice(2)}`;
  }
  return raw;
}

/** Row beneath the tabs: editable project folder + workspace actions. */
export function Toolbar() {
  const {
    state,
    sidebarOpen,
    sidebarView,
    projectRoot,
    toggleSidebar,
    setProjectRoot,
    setSidebarOpen,
    setSidebarView,
    split,
  } = useStore();

  // The "first terminal": the top-left-most pane of the first tab. Its folder
  // defines the workspace shown in the sidebar, VS Code style.
  const firstPaneId = firstLeaf(state.tabs[0].root).id;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Folder/sidebar state captured when editing starts, so Escape can undo the
  // live edits. `skipBlur` stops Escape's unmount from re-applying on blur.
  const originalRef = useRef<{ root: string | null; open: boolean }>({ root: null, open: false });
  const skipBlur = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Live update: as the path is typed, apply it the moment it names a readable
  // folder (debounced). Partial/invalid paths simply leave the sidebar as-is.
  useEffect(() => {
    if (!editing) return;
    const raw = draft.trim();
    if (!raw) return;
    let alive = true;
    const timer = setTimeout(async () => {
      const path = await expandPath(raw);
      try {
        await invoke("read_dir", { path });
      } catch {
        return; // not a folder (yet) — don't touch the sidebar or flash an error
      }
      if (!alive) return;
      setProjectRoot(path);
      setSidebarOpen(true);
      setInvalid(false);
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draft, editing]);

  const openSidebar = async () => {
    if (sidebarOpen && sidebarView === "explorer") {
      toggleSidebar(); // explorer already showing — close it
      return;
    }
    // Opening (or switching from another view): reveal the first terminal's
    // current folder in the file tree.
    setProjectRoot(await resolveCwd(firstPaneId));
    setSidebarView("explorer");
    setSidebarOpen(true);
  };

  const startEdit = () => {
    originalRef.current = { root: projectRoot, open: sidebarOpen };
    setDraft(projectRoot ?? "");
    setInvalid(false);
    setEditing(true);
  };

  // Escape: undo any live changes and restore the folder we started from.
  const cancel = () => {
    skipBlur.current = true;
    setProjectRoot(originalRef.current.root);
    setSidebarOpen(originalRef.current.open);
    setEditing(false);
  };

  // Apply the typed path to the sidebar if it points at a readable folder.
  const tryApply = async (): Promise<"ok" | "invalid" | "empty"> => {
    const raw = draft.trim();
    if (!raw) return "empty";
    const path = await expandPath(raw);
    try {
      await invoke("read_dir", { path });
    } catch {
      return "invalid";
    }
    setProjectRoot(path);
    setSidebarOpen(true);
    return "ok";
  };

  const commit = async () => {
    const result = await tryApply();
    if (result === "invalid") {
      setInvalid(true); // keep editing so the typo can be fixed
      inputRef.current?.select();
    } else {
      setEditing(false);
    }
  };

  const blurClose = async () => {
    if (skipBlur.current) {
      skipBlur.current = false; // Escape already handled this
      setEditing(false);
      return;
    }
    await tryApply(); // flush a valid path typed just before blur; discard if invalid
    setEditing(false);
  };

  return (
    <>
    <div className="toolbar">
      <button
        className={`tool-btn icon-btn${sidebarOpen && sidebarView === "explorer" ? " active" : ""}`}
        title="Show the first terminal's folder in the sidebar"
        aria-label="Show first terminal's folder"
        aria-pressed={sidebarOpen && sidebarView === "explorer"}
        onPointerDown={openSidebar}
      >
        <FolderIcon />
      </button>

      <div className="project-info" title={editing ? undefined : projectRoot ?? "No folder open"}>
        {editing ? (
          <input
            ref={inputRef}
            className={`project-edit${invalid ? " invalid" : ""}`}
            value={draft}
            spellCheck={false}
            placeholder="Folder path — Enter to open in sidebar"
            aria-label="Folder path"
            aria-invalid={invalid}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
              e.stopPropagation();
            }}
            onBlur={blurClose}
          />
        ) : projectRoot ? (
          <button
            className="project-name"
            onClick={startEdit}
            title="Click to change the folder shown in the sidebar"
          >
            <span className="project-base">{basename(projectRoot)}</span>
            <span className="project-path">{projectRoot}</span>
          </button>
        ) : (
          <button className="project-name project-empty" onClick={startEdit} title="Click to open a folder">
            No folder open
          </button>
        )}
      </div>

      <div className="toolbar-actions">
        <button
          className="tool-btn icon-btn"
          title="Split left/right"
          aria-label="Split vertical"
          onPointerDown={() => split("row")}
        >
          <SplitVerticalIcon />
        </button>
        <button
          className="tool-btn icon-btn"
          title="Split top/bottom"
          aria-label="Split horizontal"
          onPointerDown={() => split("column")}
        >
          <SplitHorizontalIcon />
        </button>

        <span className="toolbar-sep" />
        <button
          className={`tool-btn icon-btn${settingsOpen ? " active" : ""}`}
          title="Settings"
          aria-label="Settings"
          aria-pressed={settingsOpen}
          onPointerDown={() => setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
      </div>
    </div>
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
