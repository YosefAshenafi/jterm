import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/user") }));
vi.mock("./terminal/manager", () => ({
  terminals: {
    getPtyId: () => null,
    getSpawnCwd: (paneId: string) =>
      paneId === "pane-pending" ? Promise.resolve("/inherited/dir") : undefined,
  },
}));

import { basename, dirname, resolveCwd, shellQuote } from "./workspace";

describe("shellQuote (POSIX — jsdom does not report a Windows UA)", () => {
  it("wraps plain paths in single quotes", () => {
    expect(shellQuote("/Users/me/projects")).toBe("'/Users/me/projects'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
  });

  it("keeps shell metacharacters inert inside the quotes", () => {
    expect(shellQuote("/tmp/a && rm -rf b")).toBe("'/tmp/a && rm -rf b'");
  });
});

describe("basename", () => {
  it("returns the last segment of a POSIX path", () => {
    expect(basename("/a/b/c.txt")).toBe("c.txt");
  });

  it("ignores trailing separators", () => {
    expect(basename("/a/b/")).toBe("b");
  });

  it("handles Windows separators", () => {
    expect(basename("C:\\Users\\me\\proj")).toBe("proj");
  });
});

describe("dirname", () => {
  it("returns the parent of a POSIX path", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
  });

  it("returns empty for root-level and bare names", () => {
    expect(dirname("/a")).toBe("");
    expect(dirname("file.txt")).toBe("");
  });

  it("handles Windows separators", () => {
    expect(dirname("C:\\Users\\me\\proj")).toBe("C:\\Users\\me");
  });
});

describe("resolveCwd", () => {
  it("falls back to the home directory without a pane", async () => {
    expect(await resolveCwd(null)).toBe("/home/user");
  });

  it("falls back to home when the pane has no PTY yet", async () => {
    expect(await resolveCwd("pane-1")).toBe("/home/user");
  });

  it("inherits a pending spawn directory for a pane that hasn't spawned", async () => {
    expect(await resolveCwd("pane-pending")).toBe("/inherited/dir");
  });
});
