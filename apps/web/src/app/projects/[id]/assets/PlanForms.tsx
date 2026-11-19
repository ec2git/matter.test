"use client";

import { useActionState, useState } from "react";
import { createPlan, deletePlan, editPlan, type FormState } from "./actions";

function Message({ state }: { state: FormState }) {
  if (state.error) return <p className="error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="banner banner-good" role="status" style={{ margin: 0 }}>{state.ok}</p>;
  return null;
}

export type SourceChoice = { id: string; name: string; type: string };

/** Ticks for the sources a plan reads. All ticked means sources added later are read too. */
function SourcePicker({ sources, picked, setPicked, idPrefix }: { sources: SourceChoice[]; picked: Set<string>; setPicked: (s: Set<string>) => void; idPrefix: string }) {
  const all = picked.size === sources.length;
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Sources to read</legend>
      {!sources.length && <span className="small muted">No sources are ready yet. Add one under Sources first.</span>}
      {sources.map((s) => (
        <label key={s.id} htmlFor={`${idPrefix}-${s.id}`} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
          <input
            id={`${idPrefix}-${s.id}`}
            type="checkbox"
            name="sourceId"
            value={s.id}
            checked={picked.has(s.id)}
            onChange={(e) => {
              const next = new Set(picked);
              if (e.target.checked) next.add(s.id);
              else next.delete(s.id);
              setPicked(next);
            }}
          />
          <span>{s.name} <span className="muted">· {s.type}</span></span>
        </label>
      ))}
      {all && sources.length > 0 && <input type="hidden" name="allSources" value="on" />}
      {sources.length > 0 && <span className="hint small">{all ? "Sources you add later are read for this plan too." : "Only the ticked sources are read for this plan, including their newer versions."}</span>}
    </fieldset>
  );
}

/** Start a test plan on its own topic: a name, what it covers, and which of the project's sources it reads. */
export function NewPlanForm({ projectId, sources, open: startOpen }: { projectId: string; sources: SourceChoice[]; open?: boolean }) {
  const [state, action, pending] = useActionState(createPlan, {});
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sources.map((s) => s.id)));
  return (
    <details className="panel new-plan" open={startOpen || !!state.error}>
      <summary className="new-plan-summary">
        <span aria-hidden="true">+</span> New test plan
      </summary>
      <form action={action} className="stack" style={{ gap: 14, marginTop: 12 }}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="field">
          <label htmlFor="plan-name">Name</label>
          <input id="plan-name" name="name" className="input" maxLength={80} required placeholder="Click and collect" />
        </div>
        <div className="field">
          <label htmlFor="plan-focus">What this plan covers</label>
          <span className="hint small">The agent reads the sources again for this topic only, so the plan gets its own requirements, stories, scenarios and test cases. Your other plans aren&apos;t changed.</span>
          <textarea id="plan-focus" name="focus" className="input" rows={3} maxLength={1000} required placeholder="Click and collect: choosing a pickup store, pickup times, store opening hours and the pickup confirmation email." />
        </div>
        <SourcePicker sources={sources} picked={picked} setPicked={setPicked} idPrefix="new-src" />
        <Message state={state} />
        <span className="small muted">Costs about $0.15 per source to read for this plan, plus about $0.40 to draft it.</span>
        <button type="submit" className="btn" disabled={pending || !sources.length || !picked.size} style={{ alignSelf: "flex-start" }}>
          {pending ? "Starting…" : "Draft test plan"}
        </button>
      </form>
    </details>
  );
}

/** Edit a plan's name, focus and sources. Changing the focus or sources reads the sources again for it. */
export function EditPlan({ trackId, name, focus, sourceIds, sources, busy }: { trackId: string; name: string; focus: string; sourceIds: string[] | null; sources: SourceChoice[]; busy: boolean }) {
  const [state, action, pending] = useActionState(editPlan, {});
  const initial = sourceIds === null ? sources.map((s) => s.id) : sources.filter((s) => sourceIds.includes(s.id)).map((s) => s.id);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const [newFocus, setFocus] = useState(focus);
  const sameSources = picked.size === initial.length && initial.every((sid) => picked.has(sid));
  const reread = newFocus.trim() !== focus.trim() || !sameSources;
  return (
    <details className="small">
      <summary style={{ cursor: "pointer" }}>Edit</summary>
      <form action={action} className="stack" style={{ gap: 12, marginTop: 10 }}>
        <input type="hidden" name="trackId" value={trackId} />
        <div className="field">
          <label htmlFor={`edit-name-${trackId}`}>Name</label>
          <input id={`edit-name-${trackId}`} name="name" className="input" defaultValue={name} maxLength={80} required />
        </div>
        <div className="field">
          <label htmlFor={`edit-focus-${trackId}`}>What this plan covers</label>
          <textarea id={`edit-focus-${trackId}`} name="focus" className="input" rows={3} maxLength={1000} required value={newFocus} onChange={(e) => setFocus(e.target.value)} />
        </div>
        <SourcePicker sources={sources} picked={picked} setPicked={setPicked} idPrefix={`edit-src-${trackId}`} />
        {reread && (
          <p className="banner" role="note" style={{ margin: 0 }}>
            The agent reads this plan&apos;s sources again for the new focus, replaces its requirements and drafts a new version. Approvals in this plan start over. Costs about $0.15 per source plus about $0.40.
          </p>
        )}
        <Message state={state} />
        <button type="submit" className="btn btn-outline btn-sm" disabled={pending || !picked.size || (reread && busy)} style={{ alignSelf: "flex-start" }}>
          {pending ? "Saving…" : reread ? "Save and read again" : "Save"}
        </button>
        {reread && busy && <span className="small muted">The agent is working on this project. Try again when it finishes.</span>}
      </form>
    </details>
  );
}

/** Delete a plan, after typing its name. */
export function DeletePlan({ trackId, name, code, only }: { trackId: string; name: string; code: string; only: boolean }) {
  const [state, action, pending] = useActionState(deletePlan, {});
  const [typed, setTyped] = useState("");
  return (
    <details className="small">
      <summary style={{ cursor: "pointer", color: "var(--crit)" }}>Delete</summary>
      {only ? (
        <p className="small muted" style={{ marginTop: 8 }}>This is the project&apos;s only test plan, so it can&apos;t be deleted. Edit it instead.</p>
      ) : (
        <form action={action} className="stack" style={{ gap: 8, marginTop: 8 }}>
          <input type="hidden" name="trackId" value={trackId} />
          <span>
            Deleting {code} removes its requirements, client questions, every version of the plan, and its user stories, scenarios and test cases, approved ones too. This can&apos;t be undone. The project&apos;s sources and other plans stay.
          </span>
          <label htmlFor={`delete-${trackId}`}>Type <strong>{name}</strong> to confirm</label>
          <input id={`delete-${trackId}`} name="confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ minHeight: 36 }} />
          <Message state={state} />
          <button type="submit" className="btn btn-sm btn-danger" disabled={pending || typed.trim().toLowerCase() !== name.toLowerCase()} style={{ alignSelf: "flex-start" }}>
            {pending ? "Deleting…" : `Delete ${code}`}
          </button>
        </form>
      )}
    </details>
  );
}
