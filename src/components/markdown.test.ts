import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown } from "./markdown";

describe("renderInline", () => {
  it("formats bold, italic, and strikethrough", () => {
    expect(renderInline("**b**")).toBe("<strong>b</strong>");
    expect(renderInline("a *i* b")).toBe("a <em>i</em> b");
    expect(renderInline("~~gone~~")).toBe("<del>gone</del>");
  });

  it("keeps code spans verbatim and unformatted", () => {
    expect(renderInline("`a*b*c`")).toBe("<code>a*b*c</code>");
    expect(renderInline("call `f()` now")).toBe("call <code>f()</code> now");
  });

  it("does not mistake plain spaced numbers for code", () => {
    expect(renderInline("`x` then 0 and 1 and 2")).toBe("<code>x</code> then 0 and 1 and 2");
  });

  it("renders safe links and drops unsafe ones", () => {
    expect(renderInline("[a](https://x.com)")).toBe('<a href="https://x.com">a</a>');
    expect(renderInline("[a](mailto:x@y.z)")).toBe('<a href="mailto:x@y.z">a</a>');
    const xss = renderInline("[a](javascript:danger)");
    expect(xss).toBe("a");
    expect(xss).not.toContain("javascript:");
  });

  it("escapes HTML so markup cannot be injected", () => {
    expect(renderInline("<img onerror=x>")).toBe("&lt;img onerror=x&gt;");
  });
});

describe("renderMarkdown", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("### Sub")).toBe("<h3>Sub</h3>");
  });

  it("wraps loose text in paragraphs", () => {
    expect(renderMarkdown("hello world")).toBe("<p>hello world</p>");
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders fenced code blocks with escaped contents", () => {
    expect(renderMarkdown("```\nx < y\n```")).toBe(
      '<pre class="md-code"><code>x &lt; y</code></pre>'
    );
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(renderMarkdown("> quote")).toBe("<blockquote><p>quote</p></blockquote>");
    expect(renderMarkdown("---")).toBe("<hr />");
  });

  it("neutralizes a raw <script> tag", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
  });
});
