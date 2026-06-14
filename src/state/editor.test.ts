import { describe, expect, it } from "vitest";
import {
  EditorMap,
  editorMapReducer,
  EditorState,
  editorReducer,
  emptyEditor,
  isDirty,
} from "./editor";

const open = (s: EditorState, path: string) =>
  editorReducer(s, { type: "open", path, name: path.split("/").pop()! });

describe("open / loaded", () => {
  it("adds a loading buffer and makes it active", () => {
    const s = open(emptyEditor, "/a.ts");
    expect(s.activePath).toBe("/a.ts");
    expect(s.files[0]).toMatchObject({ path: "/a.ts", loading: true, saved: null });
  });

  it("re-opening an open file only refocuses it", () => {
    let s = open(open(emptyEditor, "/a.ts"), "/b.ts");
    s = open(s, "/a.ts");
    expect(s.files).toHaveLength(2);
    expect(s.activePath).toBe("/a.ts");
  });

  it("loaded fills saved and draft; the buffer starts clean", () => {
    let s = open(emptyEditor, "/a.ts");
    s = editorReducer(s, { type: "loaded", path: "/a.ts", text: "v1" });
    expect(s.files[0]).toMatchObject({ saved: "v1", draft: "v1", loading: false });
    expect(isDirty(s.files[0])).toBe(false);
  });
});

describe("edit / saved", () => {
  it("editing makes the buffer dirty; a loading buffer is never dirty", () => {
    let s = open(emptyEditor, "/a.ts");
    expect(isDirty(s.files[0])).toBe(false);
    s = editorReducer(s, { type: "loaded", path: "/a.ts", text: "v1" });
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v2" });
    expect(isDirty(s.files[0])).toBe(true);
  });

  it("saved records exactly what was written — typing during a save stays dirty", () => {
    let s = open(emptyEditor, "/a.ts");
    s = editorReducer(s, { type: "loaded", path: "/a.ts", text: "v1" });
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v2" });
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v3" });
    s = editorReducer(s, { type: "saved", path: "/a.ts", text: "v2" });
    expect(s.files[0].saved).toBe("v2");
    expect(s.files[0].draft).toBe("v3");
    expect(isDirty(s.files[0])).toBe(true);
  });
});

describe("select / close", () => {
  it("select ignores paths that are not open", () => {
    const s = open(emptyEditor, "/a.ts");
    expect(editorReducer(s, { type: "select", path: "/nope" })).toBe(s);
  });

  it("closing the active file activates the neighbour that slides into its slot", () => {
    let s = open(open(open(emptyEditor, "/a.ts"), "/b.ts"), "/c.ts");
    s = editorReducer(s, { type: "select", path: "/b.ts" });
    s = editorReducer(s, { type: "close", path: "/b.ts" });
    expect(s.files.map((f) => f.path)).toEqual(["/a.ts", "/c.ts"]);
    expect(s.activePath).toBe("/c.ts");
  });

  it("closing the last file clears the active path", () => {
    let s = open(emptyEditor, "/a.ts");
    s = editorReducer(s, { type: "close", path: "/a.ts" });
    expect(s.files).toHaveLength(0);
    expect(s.activePath).toBeNull();
  });

  it("closing an inactive file leaves the active one alone", () => {
    let s = open(open(emptyEditor, "/a.ts"), "/b.ts");
    s = editorReducer(s, { type: "close", path: "/a.ts" });
    expect(s.activePath).toBe("/b.ts");
  });
});

describe("per-tab editor map", () => {
  const openIn = (m: EditorMap, tabId: string, path: string) =>
    editorMapReducer(m, { type: "open", tabId, path, name: path.split("/").pop()! });

  it("opening a file in one tab does not affect another tab", () => {
    let m: EditorMap = {};
    m = openIn(m, "tab1", "/a.ts");
    expect(m.tab1.files.map((f) => f.path)).toEqual(["/a.ts"]);
    expect(m.tab2).toBeUndefined();
  });

  it("a freshly created tab starts with no open files", () => {
    let m: EditorMap = {};
    m = openIn(m, "tab1", "/a.ts");
    m = openIn(m, "tab1", "/b.ts");
    const tab2 = m.tab2 ?? emptyEditor;
    expect(tab2.files).toHaveLength(0);
    expect(tab2.activePath).toBeNull();
  });

  it("each tab keeps its own active file independently", () => {
    let m: EditorMap = {};
    m = openIn(m, "tab1", "/a.ts");
    m = openIn(m, "tab2", "/b.ts");
    expect(m.tab1.activePath).toBe("/a.ts");
    expect(m.tab2.activePath).toBe("/b.ts");
  });

  it("prune drops entries for closed tabs and keeps the rest", () => {
    let m: EditorMap = {};
    m = openIn(m, "tab1", "/a.ts");
    m = openIn(m, "tab2", "/b.ts");
    m = editorMapReducer(m, { type: "prune", ids: new Set(["tab2"]) });
    expect(m.tab1).toBeUndefined();
    expect(m.tab2.files.map((f) => f.path)).toEqual(["/b.ts"]);
  });

  it("prune returns the same reference when nothing changes", () => {
    let m: EditorMap = {};
    m = openIn(m, "tab1", "/a.ts");
    const same = editorMapReducer(m, { type: "prune", ids: new Set(["tab1"]) });
    expect(same).toBe(m);
  });
});
