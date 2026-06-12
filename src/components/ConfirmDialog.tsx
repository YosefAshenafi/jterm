import { useEffect, type PointerEvent as ReactPointerEvent } from "react";

interface Props {
  title: string;
  message: string;
  /** Label for the confirming action (e.g. "Discard"). */
  confirmLabel?: string;
  /** Red/destructive styling for the confirm button. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app confirmation modal — a reliable "are you sure?" prompt (native
 * window.confirm is unreliable inside the webview). Esc or backdrop cancels. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);

  const keepFocus = (e: ReactPointerEvent) => e.preventDefault();

  return (
    <div className="modal-overlay" onPointerDown={onCancel}>
      <div
        className="modal modal-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-body">
          <h2 className="confirm-title">{title}</h2>
          <p className="confirm-message">{message}</p>
        </div>
        <footer className="modal-footer confirm-footer">
          <button className="btn btn-ghost" onPointerDown={keepFocus} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onPointerDown={keepFocus}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
