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
})();
