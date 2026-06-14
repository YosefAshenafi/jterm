(() => {
  "use strict";

  const links = Array.from(document.querySelectorAll(".doc-nav a"));
  const linkById = new Map(
    links.map((a) => [a.getAttribute("href").slice(1), a])
  );
  const sections = Array.from(document.querySelectorAll(".doc-section"));
  const sidebar = document.getElementById("doc-sidebar");

  let current = "";
  function setActive(id) {
    if (id === current || !linkById.has(id)) return;
    current = id;
    links.forEach((a) => a.classList.remove("active"));
    const link = linkById.get(id);
    link.classList.add("active");
    link.scrollIntoView({ block: "nearest" });
  }

  /* Scrollspy: the active section is the topmost one whose heading has scrolled
     under the sticky nav. */
  if ("IntersectionObserver" in window && sections.length) {
    const visible = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) =>
          e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)
        );
        let top = null;
        let topY = Infinity;
        visible.forEach((s) => {
          const y = s.getBoundingClientRect().top;
          if (y < topY) {
            topY = y;
            top = s;
          }
        });
        if (top) setActive(top.id);
      },
      { rootMargin: "-82px 0px -68% 0px", threshold: 0 }
    );
    sections.forEach((s) => io.observe(s));
  }

  /* Mobile sidebar toggle */
  const toggle = document.querySelector(".docs-nav-toggle");
  if (toggle && sidebar) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      sidebar.classList.toggle("open", open);
    };
    toggle.addEventListener("click", () =>
      setOpen(!sidebar.classList.contains("open"))
    );
    sidebar.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => setOpen(false))
    );
  }

  /* Reflect the active link immediately when arriving via a hash link. */
  const fromHash = () => {
    const id = location.hash.slice(1);
    if (id) setActive(id);
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();

  /* ---- Search (client-side, over section content) ---- */
  const input = document.getElementById("doc-search-input");
  const results = document.getElementById("doc-search-results");
  if (input && results) {
    const index = sections.map((s) => {
      const h = s.querySelector("h2");
      return {
        id: s.id,
        title: h ? h.textContent.trim() : s.id,
        text: (s.textContent || "").replace(/\s+/g, " ").trim(),
      };
    });

    const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    const esc = (str) => str.replace(/[&<>"]/g, (c) => ESC[c]);

    function snippet(text, q) {
      const i = text.toLowerCase().indexOf(q);
      if (i === -1) return esc(text.slice(0, 110));
      const start = Math.max(0, i - 32);
      const slice = (start > 0 ? "… " : "") + text.slice(start, start + 120);
      const at = slice.toLowerCase().indexOf(q);
      if (at === -1) return esc(slice);
      return (
        esc(slice.slice(0, at)) +
        "<mark>" + esc(slice.slice(at, at + q.length)) + "</mark>" +
        esc(slice.slice(at + q.length))
      );
    }

    let items = [];
    let active = -1;

    function close() {
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      items = [];
      active = -1;
    }
    function go(id) {
      close();
      input.value = "";
      location.hash = "#" + id;
    }
    function highlight(idx) {
      if (!items.length) return;
      active = (idx + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("active", i === active));
      items[active].scrollIntoView({ block: "nearest" });
    }
    function render(q) {
      const ql = q.toLowerCase();
      const matches = index
        .filter((e) => e.title.toLowerCase().includes(ql) || e.text.toLowerCase().includes(ql))
        .slice(0, 8);
      if (!matches.length) {
        results.innerHTML =
          '<div class="doc-search-empty">No results for “' + esc(q) + "”</div>";
      } else {
        results.innerHTML = matches
          .map(
            (e) =>
              '<button class="doc-result" type="button" role="option" data-id="' + e.id + '">' +
              '<span class="doc-result-title">' + esc(e.title) + "</span>" +
              '<span class="doc-result-snippet">' + snippet(e.text, ql) + "</span></button>"
          )
          .join("");
      }
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
      items = Array.from(results.querySelectorAll(".doc-result"));
      active = -1;
      items.forEach((el) => el.addEventListener("click", () => go(el.dataset.id)));
    }

    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (!q) close();
      else render(q);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight(active + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight(active - 1);
      } else if (e.key === "Enter") {
        const target = active >= 0 ? items[active] : items[0];
        if (target) {
          e.preventDefault();
          go(target.dataset.id);
        }
      } else if (e.key === "Escape") {
        if (results.hidden) input.blur();
        else close();
      }
    });
    document.addEventListener("click", (e) => {
      if (!results.hidden && !e.target.closest(".doc-search")) close();
    });
    document.addEventListener("keydown", (e) => {
      const el = document.activeElement;
      const typing = el && /^(INPUT|TEXTAREA)$/.test(el.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        sidebar && sidebar.classList.add("open");
        input.focus();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        sidebar && sidebar.classList.add("open");
        input.focus();
      }
    });
  }
})();
