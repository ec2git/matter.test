"use client";

import { useId, useRef, useState } from "react";

/**
 * A button that asks first. Anything that starts the agent costs money, so the click opens a dialog saying what
 * will happen, and the action only runs from the dialog's confirm button.
 */
export function ConfirmAction({ action, fields, label, className, disabled, title, heading, subtitle, intro, points, confirmLabel, confirmDisabled, children }: {
  action: (formData: FormData) => void | Promise<void>;
  /** Hidden form fields sent with the action. */
  fields: Record<string, string>;
  label: React.ReactNode;
  className: string;
  disabled?: boolean;
  /** Tooltip on the button. */
  title?: string;
  heading: string;
  subtitle?: string;
  intro?: React.ReactNode;
  points: React.ReactNode[];
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Extra form fields shown in the dialog, before the list of what happens. */
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className={className} disabled={disabled} title={title} aria-haspopup="dialog" onClick={() => { setSending(false); ref.current?.showModal(); }}>
        {label}
      </button>
      <dialog ref={ref} className="dialog dialog-sm" aria-labelledby={`${id}-title`} onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}>
        <form action={action} onSubmit={() => { setSending(true); setTimeout(() => ref.current?.close(), 0); }}>
          {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <div className="dialog-head">
            <div>
              <h2 id={`${id}-title`}>{heading}</h2>
              {subtitle && <span className="muted small" style={{ overflowWrap: "anywhere" }}>{subtitle}</span>}
            </div>
          </div>
          <div className="dialog-body" style={{ gap: 12 }}>
            {intro && <p style={{ margin: 0 }}>{intro}</p>}
            {children}
            <ul className="ul small" style={{ margin: 0 }}>
              {points.filter(Boolean).map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-outline" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" className="btn" disabled={sending || confirmDisabled}>{confirmLabel}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
