import { describe, expect, it } from "vitest";
import { EditorState, editorReducer, emptyEditor, isDirty } from "./editor";

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
    expect(isDirty(s.files[0])).toBe(false); // saved === null
    s = editorReducer(s, { type: "loaded", path: "/a.ts", text: "v1" });
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v2" });
    expect(isDirty(s.files[0])).toBe(true);
  });

  it("saved records exactly what was written — typing during a save stays dirty", () => {
    let s = open(emptyEditor, "/a.ts");
    s = editorReducer(s, { type: "loaded", path: "/a.ts", text: "v1" });
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v2" });
    // The save of "v2" is in flight while the user types "v3"...
    s = editorReducer(s, { type: "edit", path: "/a.ts", draft: "v3" });
    // ...then the write of "v2" completes.
    s = editorReducer(s, { type: "saved", path: "/a.ts", text: "v2" });
    expect(s.files[0].saved).toBe("v2");
    expect(s.files[0].draft).toBe("v3");
    expect(isDirty(s.files[0])).toBe(true); // "v3" never reached disk
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
