# jterm website

The landing site for jterm: a single static page (HTML, CSS, vanilla JS) with
no build step and no dependencies.

## Preview locally

Open `index.html` directly, or serve it:

```sh
cd website
python3 -m http.server 8080   # → http://localhost:8080
```

## Files

- `index.html`: markup and content.
- `styles.css`: design tokens (color, type, spacing) and layout.
- `main.js`: OS-aware download button, the hero terminal typing animation,
  scroll reveal, the mobile menu, and copy-to-clipboard. Progressive
  enhancement: the page is fully readable with JavaScript disabled.
- `assets/`: logo and icon.

## Deploy

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push
to `main` that touches `website/`. Enable it once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**. It then
goes live at `https://yosefashenafi.github.io/jterm/`.

## Keeping it accurate

Download links point at the `v0.2.0` release assets and the feature copy mirrors
the app's [README](../README.md). Update both when a new version ships.
