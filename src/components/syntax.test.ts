import { describe, expect, it } from "vitest";
import { highlightToHtml, languageFromName } from "./syntax";

describe("languageFromName", () => {
  it("maps by extension and a few special filenames", () => {
    expect(languageFromName("app.tsx")).toBe("cstyle");
    expect(languageFromName("main.py")).toBe("python");
    expect(languageFromName("build.sh")).toBe("shell");
    expect(languageFromName("data.json")).toBe("json");
    expect(languageFromName("Dockerfile")).toBe("shell");
    expect(languageFromName("notes.md")).toBe("plain");
    expect(languageFromName("noextension")).toBe("plain");
  });
});

describe("highlightToHtml", () => {
  it("colors keywords, strings, numbers and comments", () => {
    const html = highlightToHtml(`const x = 42 // hi`, "cstyle");
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-number">42</span>');
    expect(html).toContain('<span class="tok-comment">// hi</span>');
  });

  it("colors a string token", () => {
    const html = highlightToHtml(`let s = "hello"`, "cstyle");
    expect(html).toContain('<span class="tok-string">"hello"</span>');
  });

  it("escapes HTML so file content can never inject markup", () => {
    const html = highlightToHtml(`x = "<script>&"`, "cstyle");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;&amp;");
  });

  it("leaves plain text uncolored but escaped", () => {
    const html = highlightToHtml("a < b & c", "plain");
    expect(html).toBe("a &lt; b &amp; c\n");
  });
});
