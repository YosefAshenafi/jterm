import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, hexToRgba, loadSettings, saveSettings } from "./settings";

beforeEach(() => localStorage.clear());

describe("load/save settings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips through localStorage", () => {
    const custom = { ...DEFAULT_SETTINGS, accent: "#e06c75", fontSize: 16, cursorBlink: false };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it("merges partial stored settings over the defaults", () => {
    // A newer build may add fields older stored blobs don't have.
    localStorage.setItem("jterm.settings", JSON.stringify({ fontSize: 18 }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, fontSize: 18 });
  });

  it("falls back to defaults on corrupt JSON", () => {
    localStorage.setItem("jterm.settings", "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("hexToRgba", () => {
  it("converts #rrggbb", () => {
    expect(hexToRgba("#5ac8fa", 0.5)).toBe("rgba(90, 200, 250, 0.5)");
  });

  it("expands #rgb shorthand", () => {
    expect(hexToRgba("#fff", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  it("falls back to the default blue on garbage input", () => {
    expect(hexToRgba("not-a-color", 0.5)).toBe("rgba(90, 200, 250, 0.5)");
    expect(hexToRgba("#12345", 0.5)).toBe("rgba(90, 200, 250, 0.5)");
  });
});
