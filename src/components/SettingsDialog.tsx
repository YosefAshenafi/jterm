import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import {
  ACCENT_PRESETS,
  CURSOR_STYLES,
  DEFAULT_SETTINGS,
  FONT_PRESETS,
  SCROLLBACK_PRESETS,
} from "../state/settings";

const FONT_MIN = 8;
const FONT_MAX = 28;
const WEBSITE = "https://yosefashenafi.github.io";

type Tab = "appearance" | "terminal" | "about";
const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: "appearance", label: "Appearance", glyph: "◧" },
  { id: "terminal", label: "Terminal", glyph: "›_" },
  { id: "about", label: "About", glyph: "ⓘ" },
];

/** App info + customizable appearance/terminal settings, organized into a small
 * left-nav like a real terminal's preferences. Changes apply live through the
 * store; Escape or a backdrop click closes it. A preview reflects the font,
 * cursor, and accent choices as they're made. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useStore();
  const [tab, setTab] = useState<Tab>("appearance");

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
  const setLineHeight = (n: number) =>
    updateSettings({ lineHeight: Math.min(2, Math.max(1, Math.round(n * 10) / 10)) });

  // Buttons act on click so Enter/Space work, but swallow pointerdown so a
  // mouse press never steals focus from the terminal behind the dialog.
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();

  const preview = (
    <div
      className="settings-preview"
      aria-hidden="true"
      style={{
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
      }}
    >
      <div className="sp-line">
        <span className="sp-dim">~/projects/jterm</span>
      </div>
      <div className="sp-line">
        <span className="sp-prompt">$</span> npm run dev
        <span
          className={`sp-cursor sp-cursor-${settings.cursorStyle}${
            settings.cursorBlink ? " blink" : ""
          }`}
          style={{ color: settings.accent }}
        />
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onPointerDown={onClose}>
      <div
        className="modal modal-settings"
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

        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`settings-nav-item${tab === t.id ? " active" : ""}`}
                onPointerDown={keepFocus}
                onClick={() => setTab(t.id)}
              >
                <span className="settings-nav-glyph" aria-hidden="true">{t.glyph}</span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {tab !== "about" && preview}

            {tab === "appearance" && (
              <section className="setting-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <span className="setting-name">Accent color</span>
                    <span className="setting-hint">Active outline, cursor &amp; highlights</span>
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
                    <span className="setting-name">Font</span>
                    <span className="setting-hint">Monospace family for every terminal</span>
                  </div>
                  <select
                    className="setting-select"
                    value={settings.fontFamily}
                    aria-label="Terminal font"
                    onChange={(e) => updateSettings({ fontFamily: e.target.value })}
                  >
                    {FONT_PRESETS.map((f) => (
                      <option key={f.label} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <span className="setting-name">Font size</span>
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
                    <span className="setting-name">Line height</span>
                    <span className="setting-hint">Vertical spacing between rows</span>
                  </div>
                  <div className="stepper">
                    <button
                      className="stepper-btn"
                      aria-label="Decrease line height"
                      disabled={settings.lineHeight <= 1}
                      onPointerDown={keepFocus}
                      onClick={() => setLineHeight(settings.lineHeight - 0.1)}
                    >
                      −
                    </button>
                    <span className="stepper-value">{settings.lineHeight.toFixed(1)}</span>
                    <button
                      className="stepper-btn"
                      aria-label="Increase line height"
                      disabled={settings.lineHeight >= 2}
                      onPointerDown={keepFocus}
                      onClick={() => setLineHeight(settings.lineHeight + 0.1)}
                    >
                      +
                    </button>
                  </div>
                </div>
              </section>
            )}

            {tab === "terminal" && (
              <section className="setting-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <span className="setting-name">Cursor style</span>
                    <span className="setting-hint">Shape of the terminal caret</span>
                  </div>
                  <div className="segmented" role="group" aria-label="Cursor style">
                    {CURSOR_STYLES.map((cs) => (
                      <button
                        key={cs.value}
                        className={`segmented-btn${
                          settings.cursorStyle === cs.value ? " active" : ""
                        }`}
                        aria-pressed={settings.cursorStyle === cs.value}
                        onPointerDown={keepFocus}
                        onClick={() => updateSettings({ cursorStyle: cs.value })}
                      >
                        {cs.label}
                      </button>
                    ))}
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

                <div className="setting-row">
                  <div className="setting-label">
                    <span className="setting-name">Scrollback</span>
                    <span className="setting-hint">Lines of history kept per terminal</span>
                  </div>
                  <select
                    className="setting-select"
                    value={settings.scrollback}
                    aria-label="Scrollback lines"
                    onChange={(e) => updateSettings({ scrollback: Number(e.target.value) })}
                  >
                    {SCROLLBACK_PRESETS.map((n) => (
                      <option key={n} value={n}>
                        {n.toLocaleString()} lines
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            )}

            {tab === "about" && (
              <section className="setting-group">
                <div className="about">
                  <img className="about-logo" src="/jterm.png" alt="jterm" draggable={false} />
                  <div className="about-text">
                    <div className="about-name">
                      jterm{" "}
                      {version !== null && <span className="about-version">v{version}</span>}
                    </div>
                    <p className="about-desc">
                      A fast, tabbed, splittable terminal with full mouse support, drag-and-drop
                      panes, and a built-in syntax-highlighting editor. Built with Tauri + React.
                    </p>
                  </div>
                </div>
                <dl className="about-meta">
                  <div className="about-meta-row">
                    <dt>Developer</dt>
                    <dd>Yosef Ashenafi</dd>
                  </div>
                  <div className="about-meta-row">
                    <dt>Website</dt>
                    <dd>
                      <button
                        className="about-link"
                        onPointerDown={keepFocus}
                        onClick={() => void openUrl(WEBSITE)}
                      >
                        yosefashenafi.github.io
                      </button>
                    </dd>
                  </div>
                </dl>
              </section>
            )}
          </div>
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
