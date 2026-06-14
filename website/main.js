(() => {
  "use strict";

  const RELEASES = "https://github.com/YosefAshenafi/jterm/releases/download/v0.2.0";
  const MAC_DMG = `${RELEASES}/jterm_0.2.0_universal.dmg`;
  const WIN_EXE = `${RELEASES}/jterm_0.2.0_x64-setup.exe`;
  const LINUX_DEB = `${RELEASES}/jterm_0.2.0_amd64.deb`;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ua = navigator.userAgent;
  const platform = navigator.platform || "";
  const isMac = /Mac|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua);
  const isWindows = /Win/.test(platform) || /Windows/.test(ua);
  const isLinux = /Linux/.test(ua) && !/Android/.test(ua);

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
  } else if (isLinux) {
    if (primaryLabel) primaryLabel.textContent = "Download for Linux";
    if (primary) primary.href = LINUX_DEB;
    if (primaryIco) primaryIco.style.display = "none";
    detectedBadge(document.getElementById("dl-linux"));
  } else {
    if (primaryLabel) primaryLabel.textContent = "Download";
    if (primary) primary.href = "#download";
    if (primaryIco) primaryIco.style.display = "none";
  }

  /* ---- Homepage nav active state (scrollspy over in-page sections) ---- */
  const navLinks = document.querySelectorAll(".nav-links a[href^='#']");
  if (navLinks.length && "IntersectionObserver" in window) {
    const linkFor = new Map();
    navLinks.forEach((a) => {
      const sec = document.getElementById(a.getAttribute("href").slice(1));
      if (sec) linkFor.set(sec, a);
    });
    if (linkFor.size) {
      const vis = new Set();
      const spy = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => (e.isIntersecting ? vis.add(e.target) : vis.delete(e.target)));
          let top = null;
          let topY = Infinity;
          vis.forEach((s) => {
            const y = s.getBoundingClientRect().top;
            if (y < topY) {
              topY = y;
              top = s;
            }
          });
          navLinks.forEach((a) => a.classList.remove("active"));
          if (top) linkFor.get(top).classList.add("active");
        },
        { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
      );
      linkFor.forEach((_, sec) => spy.observe(sec));
    }
  }

  /* ---- Hero terminal: a looping IDE demo (replays continuously) ---- */
  (function heroTerminal() {
    const term = document.querySelector(".hero-term");
    const runEl = term && term.querySelector(".term-run");
    const spark = term && term.querySelector(".term-spark");
    if (!term || !runEl || !spark) return;

    const trainLoss = term.querySelector(".train-loss");
    const trainEpoch = term.querySelector(".term-train .ok");

    const scenes = [
      {
        dir: "jterm",
        cmd: "cargo run --release",
        out: [
          { k: "Compiling", v: " jterm v0.2.0" },
          { k: "Finished", v: " release in 0.8s" },
          { dim: true, v: "Running `target/release/jterm`" },
        ],
      },
      {
        dir: "jterm",
        cmd: "git push",
        out: [
          { dim: true, v: "Enumerating objects: 12, done." },
          { dim: true, v: "Writing objects: 100% (7/7), 1.1 KiB" },
          { k: "main -> main", v: "  3a9f1c2..7b2e441" },
        ],
      },
      {
        dir: "web",
        cmd: "pnpm dev",
        out: [
          { k: "VITE", v: " v5.4  ready in 312 ms" },
          { dim: true, v: "➜ Local:  http://localhost:5173/" },
          { dim: true, v: "➜ press h + enter to show help" },
        ],
      },
      {
        dir: "jterm",
        cmd: 'rg "spawn_pty" -n',
        out: [
          { dim: true, v: "src/main.rs:14: fn spawn_pty(id)" },
          { dim: true, v: "src/pty.rs:8: pub fn spawn_pty()" },
          { k: "2 matches", v: " in 6 ms" },
        ],
      },
    ];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const make = (tag, cls) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      return n;
    };

    function promptLine(dir, withCaret) {
      const line = make("div", "term-line");
      const p = make("span", "p");
      p.textContent = dir;
      const c = make("span", "c");
      c.textContent = "$";
      line.append(p, document.createTextNode(" "), c, document.createTextNode(" "));
      const typed = make("span", "typed");
      line.appendChild(typed);
      if (withCaret) line.appendChild(make("span", "caret"));
      return { line, typed };
    }

    function typeInto(node, text) {
      return new Promise((resolve) => {
        let i = 0;
        const tick = () => {
          node.textContent = text.slice(0, i);
          if (i++ <= text.length) setTimeout(tick, 42 + Math.random() * 34);
          else resolve();
        };
        tick();
      });
    }

    function outLine(o) {
      const el = make("div", "term-out fade" + (o.dim ? " dim" : ""));
      if (o.k) {
        const k = make("span", "ok");
        k.textContent = o.k;
        el.appendChild(k);
      }
      el.appendChild(document.createTextNode(o.v));
      return el;
    }

    async function playScene(s) {
      const { line, typed } = promptLine(s.dir, true);
      runEl.appendChild(line);
      await typeInto(typed, s.cmd);
      const caret = line.querySelector(".caret");
      await sleep(280);
      if (caret) caret.remove();

      for (const o of s.out) {
        const el = outLine(o);
        runEl.appendChild(el);
        void el.offsetWidth;
        el.classList.add("in");
        await sleep(250);
      }

      const tail = make("div", "term-line fade");
      const p = make("span", "p");
      p.textContent = s.dir;
      const c = make("span", "c");
      c.textContent = "$";
      const blink = make("span", "blink");
      blink.textContent = "▍";
      tail.append(p, document.createTextNode(" "), c, document.createTextNode(" "), blink);
      runEl.appendChild(tail);
      void tail.offsetWidth;
      tail.classList.add("in");

      await sleep(2600);
      runEl.classList.add("clearing");
      await sleep(380);
      runEl.textContent = "";
      runEl.classList.remove("clearing");
    }

    function renderSpark(heights) {
      spark.textContent = "";
      heights.forEach((h) => {
        const b = make("i");
        b.style.height = h + "%";
        spark.appendChild(b);
      });
    }

    let heights = [82, 70, 64, 52, 46, 38, 32, 27];
    let epoch = 8;
    let loss = 0.182;

    function startTraining() {
      renderSpark(heights);
      setInterval(() => {
        let v = heights[heights.length - 1] * 0.86 + (Math.random() * 6 - 2);
        let newRun = false;
        if (v < 16) {
          v = 80 + Math.random() * 9;
          newRun = true;
        }
        heights = heights.slice(1).concat(Math.max(14, Math.min(94, v)));
        renderSpark(heights);
        if (newRun) {
          epoch = 1;
          loss = 0.4 + Math.random() * 0.2;
        } else {
          epoch += 1;
          loss = Math.max(0.05, loss * 0.9);
        }
        if (trainEpoch) trainEpoch.textContent = "epoch " + epoch;
        if (trainLoss) trainLoss.textContent = loss.toFixed(3);
      }, 1500);
    }

    if (reduceMotion) {
      const s = scenes[0];
      const { line, typed } = promptLine(s.dir, false);
      typed.textContent = s.cmd;
      runEl.appendChild(line);
      s.out.forEach((o) => {
        const el = outLine(o);
        el.classList.add("in");
        runEl.appendChild(el);
      });
      renderSpark(heights);
      return;
    }

    startTraining();
    (async function loop() {
      await sleep(750);
      let i = 0;
      while (true) {
        await playScene(scenes[i % scenes.length]);
        i += 1;
      }
    })();
  })();

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
