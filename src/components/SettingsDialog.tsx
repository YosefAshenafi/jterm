import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../state/store";
import { ACCENT_PRESETS, DEFAULT_SETTINGS } from "../state/settings";

const FONT_MIN = 8;
const FONT_MAX = 28;

/** App info + customizable appearance/terminal settings. Changes apply live
 * through the store; Escape or a backdrop click closes it. A small terminal
 * preview reflects the accent and cursor choices as they're made. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useStore();

  // Version comes from the running app (tauri.conf.json), so the About box
  // can't drift from the build the way a hardcoded string would.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const accentSelected = (c: string) =>
    settings.accent.toLowerCase() === c.toLowerCase();
  const setFont = (n: number) =>
    updateSettings({ fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, n)) });

  // Buttons act on click so Enter/Space work, but swallow pointerdown so a
  // mouse press never steals focus from the terminal behind the dialog.
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="modal-overlay" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-heading">
            <span className="modal-eyebrow">jterm</span>
            <h2 className="modal-title">Settings</h2>
          </div>
          <button
            className="modal-close"
            aria-label="Close settings"
            onPointerDown={keepFocus}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <section className="setting-group">
            <h3 className="setting-group-title">Appearance</h3>

            {/* Live preview — mirrors the accent (border + cursor) and blink. */}
            <div className="settings-preview" aria-hidden="true">
              <div className="sp-line">
                <span className="sp-dim">~/projects/jterm</span>
              </div>
              <div className="sp-line">
                <span className="sp-prompt">$</span> npm run dev
                <span className={`sp-cursor${settings.cursorBlink ? " blink" : ""}`} />
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">
                <span className="setting-name">Border &amp; accent color</span>
                <span className="setting-hint">Active terminal outline, cursor &amp; highlights</span>
              </div>
              <div className="swatches">
                {ACCENT_PRESETS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${accentSelected(c) ? " selected" : ""}`}
                    style={{ background: c }}
                    title={c}
                    aria-label={`Accent color ${c}`}
                    aria-pressed={accentSelected(c)}
                    onPointerDown={keepFocus}
                    onClick={() => updateSettings({ accent: c })}
                  >
                    {accentSelected(c) ? <span className="swatch-check">✓</span> : null}
                  </button>
                ))}
                <label className="swatch swatch-custom" title="Custom color">
                  <input
                    type="color"
                    value={settings.accent}
                    aria-label="Custom accent color"
                    onChange={(e) => updateSettings({ accent: e.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">
                <span className="setting-name">Terminal font size</span>
                <span className="setting-hint">Applies to every open terminal</span>
              </div>
              <div className="stepper">
                <button
                  className="stepper-btn"
                  aria-label="Decrease font size"
                  disabled={settings.fontSize <= FONT_MIN}
                  onPointerDown={keepFocus}
                  onClick={() => setFont(settings.fontSize - 1)}
                >
                  −
                </button>
                <span className="stepper-value">
                  {settings.fontSize}
                  <span className="stepper-unit">px</span>
                </span>
                <button
                  className="stepper-btn"
                  aria-label="Increase font size"
                  disabled={settings.fontSize >= FONT_MAX}
                  onPointerDown={keepFocus}
                  onClick={() => setFont(settings.fontSize + 1)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">
                <span className="setting-name">Cursor blink</span>
                <span className="setting-hint">Blink the terminal cursor</span>
              </div>
              <button
                className={`toggle${settings.cursorBlink ? " on" : ""}`}
                role="switch"
                aria-checked={settings.cursorBlink}
                aria-label="Cursor blink"
                onPointerDown={keepFocus}
                onClick={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          </section>

          <section className="setting-group">
            <h3 className="setting-group-title">About</h3>
            <div className="about">
              <div className="about-mark" aria-hidden="true">&gt;_</div>
              <div className="about-text">
                <div className="about-name">
                  jterm{" "}
                  {version !== null && (
                    <span className="about-version">v{version}</span>
                  )}
                </div>
                <p className="about-desc">
                  A fast, tabbed, splittable terminal with full mouse support and a
                  built-in file editor. Built with Tauri + React.
                </p>
              </div>
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <span className="modal-hint">
            <kbd>Esc</kbd> to close
          </span>
          <div className="modal-footer-actions">
            <button
              className="btn btn-ghost"
              onPointerDown={keepFocus}
              onClick={() => updateSettings(DEFAULT_SETTINGS)}
            >
              Reset to defaults
            </button>
            <button className="btn btn-primary" onPointerDown={keepFocus} onClick={onClose}>
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
