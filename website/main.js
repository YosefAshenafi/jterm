(() => {
  "use strict";

  const RELEASES = "https://github.com/YosefAshenafi/jterm/releases/download/v0.1.0";
  const MAC_DMG = `${RELEASES}/jterm_0.1.0_universal.dmg`;
  const WIN_EXE = `${RELEASES}/jterm_0.1.0_x64-setup.exe`;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ua = navigator.userAgent;
  const platform = navigator.platform || "";
  const isMac = /Mac|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua);
  const isWindows = /Win/.test(platform) || /Windows/.test(ua);

  /* ---- OS-aware primary download + highlighted card ---- */
  const primary = document.getElementById("primary-download");
  const primaryLabel = document.getElementById("primary-download-label");
  const primaryIco = document.getElementById("primary-os-ico");
  const WIN_ICON =
    "M0 2.4 6.5 1.5V7.6H0V2.4Zm0 11.2 6.5.9V8.4H0v5.2ZM7.3 1.4 16 .2v7.4H7.3V1.4Zm0 13.2L16 15.8V8.4H7.3v6.2Z";

  function detectedBadge(card) {
    if (!card) return;
    card.classList.add("detected");
    const head = card.querySelector(".dl-head h3");
    if (head && !card.querySelector(".detected-badge")) {
      const b = document.createElement("span");
      b.className = "detected-badge";
      b.textContent = "Detected · recommended";
      card.insertBefore(b, card.firstChild);
    }
  }

  if (isWindows) {
    if (primaryLabel) primaryLabel.textContent = "Download for Windows";
    if (primary) primary.href = WIN_EXE;
    if (primaryIco) primaryIco.querySelector("path").setAttribute("d", WIN_ICON);
    detectedBadge(document.getElementById("dl-windows"));
  } else if (isMac) {
    if (primary) primary.href = MAC_DMG;
    detectedBadge(document.getElementById("dl-macos"));
  } else {
    if (primaryLabel) primaryLabel.textContent = "Download";
    if (primary) primary.href = "#download";
    if (primaryIco) primaryIco.style.display = "none";
  }

  /* ---- Hero terminal: type the command, then reveal output ---- */
  const typed = document.querySelector(".typed");
  if (typed) {
    const text = typed.getAttribute("data-text") || "";
    if (reduceMotion) {
      typed.textContent = text;
    } else {
      let i = 0;
      const tick = () => {
        typed.textContent = text.slice(0, i);
        if (i++ <= text.length) setTimeout(tick, 45 + Math.random() * 35);
      };
      tick();
    }
  }

  /* ---- Scroll reveal (progressive enhancement) ---- */
  const revealTargets = document.querySelectorAll(
    ".section-head, .tile, .sc, .dl-card, .hood-copy, .hood-card, .stats"
  );
  if (!reduceMotion && "IntersectionObserver" in window) {
    revealTargets.forEach((el) => el.classList.add("reveal-on-scroll"));
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            obs.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 }
    );
    revealTargets.forEach((el) => io.observe(el));
  }

  /* ---- Mobile menu ---- */
  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      menu.hidden = !open;
    };
    toggle.addEventListener("click", () => setOpen(menu.hidden));
    menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setOpen(false)));
  }

  /* ---- Copy build command ---- */
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        const label = btn.querySelector(".copy-label");
        const prev = label ? label.textContent : "";
        btn.classList.add("copied");
        if (label) label.textContent = "Copied";
        setTimeout(() => {
          btn.classList.remove("copied");
          if (label) label.textContent = prev;
        }, 1800);
      } catch {
        /* clipboard unavailable */
      }
    });
  });

  /* ---- Year in footer (kept current without a rebuild) ---- */
  const yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
