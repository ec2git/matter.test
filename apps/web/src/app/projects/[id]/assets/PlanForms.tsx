"use client";

import { useActionState, useState } from "react";
import { ConfirmAction } from "@/components/ConfirmAction";
import { createPlan, deletePlan, draftAgain, editPlan, sendToJira, type FormState } from "./actions";

function Message({ state }: { state: FormState }) {
  if (state.error) return <p className="error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="banner banner-good" role="status" style={{ margin: 0 }}>{state.ok}</p>;
  return null;
}

export type SourceChoice = { id: string; name: string; type: string; confluence?: boolean };

/** Ticks for the sources a plan reads. All ticked means sources added later are read too. */
function SourcePicker({ sources, picked, setPicked, idPrefix, scroll }: { sources: SourceChoice[]; picked: Set<string>; setPicked: (s: Set<string>) => void; idPrefix: string; scroll?: boolean }) {
  const all = picked.size === sources.length;
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="row" style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, gap: 10, width: "100%" }}>
        Sources to read
        {sources.length > 3 && (
          <span className="row small" style={{ gap: 8, fontWeight: 400 }}>
            <button type="button" className="link-btn small" onClick={() => setPicked(new Set(sources.map((s) => s.id)))} disabled={all}>All</button>
            <button type="button" className="link-btn small" onClick={() => setPicked(new Set())} disabled={!picked.size}>None</button>
          </span>
        )}
      </legend>
      {!sources.length && <span className="small muted">No sources are ready yet. Add one under Sources first.</span>}
      <div className="stack" style={{ gap: 6, ...(scroll ? { maxHeight: 220, overflowY: "auto", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 } : {}) }}>
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
      </div>
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

/**
 * "Draft again" opens a dialog first: drafting runs the agent and costs money, so nothing starts until the user
 * confirms. The dialog lets them pick the plan's sources; when the plan reads Confluence pages, Confluence is checked
 * for updates before drafting.
 */
export function DraftAgain({ projectId, trackId, label, title, version, requirements, lastCost, disabled, className, sourceIds, sources }: {
  projectId: string;
  trackId: string;
  label: string;
  /** "TP01 · Booking and Appointments" */
  title: string;
  /** The current version, or null when the plan hasn't been drafted. */
  version: number | null;
  requirements: number;
  /** What the last draft of this plan cost, in dollars, if known. */
  lastCost: number | null;
  disabled?: boolean;
  className: string;
  /** The sources the plan reads now; null means all of them. */
  sourceIds: string[] | null;
  /** The project's ready sources to choose from. */
  sources: SourceChoice[];
}) {
  const initial = sourceIds === null ? sources.map((s) => s.id) : sources.filter((s) => sourceIds.includes(s.id)).map((s) => s.id);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const added = [...picked].filter((sid) => !initial.includes(sid)).length;
  const dropped = initial.filter((sid) => !picked.has(sid)).length;
  const confluence = sources.filter((s) => s.confluence && picked.has(s.id)).length;
  const cost = lastCost ? `about $${lastCost.toFixed(2)}, like the last draft` : "about $0.40";
  return (
    <ConfirmAction
      action={draftAgain}
      fields={{ projectId, trackId }}
      label={label}
      className={className}
      disabled={disabled}
      heading="Draft this test plan again?"
      subtitle={title}
      intro={<>The agent drafts {version ? `version ${version + 1}` : "a new version"} from the sources ticked below. It currently has {requirements === 1 ? "1 requirement" : `${requirements} requirements`}; rejected ones are left out.</>}
      points={[
        confluence
          ? picked.size === sources.length
            ? "First, every Confluence page in the project is checked for updates, since this plan reads all sources; new pages in its folders are added. Unchanged pages are skipped at no cost; a changed page is read again, about $0.15 per page for each plan that uses it, and those other plans are drafted again too."
            : `First, the ${confluence === 1 ? "Confluence page" : `${confluence} Confluence pages`} this plan reads ${confluence === 1 ? "is" : "are"} checked for updates; other pages in the project aren't. Unchanged pages are skipped at no cost; a changed page is read again, about $0.15 for each plan that uses it.`
          : null,
        added ? `${added === 1 ? "1 newly ticked source is" : `${added} newly ticked sources are`} read for this plan, about $0.15 each.` : null,
        dropped ? `Requirements from ${dropped === 1 ? "the source" : `the ${dropped} sources`} you unticked are dropped from this plan, approved ones too.` : null,
        "Approved user stories and test cases are kept as they are. Everything still waiting for review is replaced.",
        version ? `Version ${version} stays in the history but is no longer the current plan.` : null,
        `Drafting usually takes a few minutes and costs ${cost}.`,
      ]}
      confirmLabel={confluence ? "Check and draft" : "Draft again"}
      confirmDisabled={!picked.size}
    >
      <SourcePicker sources={sources} picked={picked} setPicked={setPicked} idPrefix={`draft-src-${trackId}`} scroll />
    </ConfirmAction>
  );
}

/**
 * "Send to Jira": the plan becomes an Epic and each approved test case a Task under it. Asks first, since it writes
 * to the client's board; the Jira project can be changed in the dialog (try a demo project before the real one).
 */
export function SendToJira({ projectId, trackId, code, name, approved, notApproved, sent, defaultProject, epicKey, disabled, className }: {
  projectId: string;
  trackId: string;
  code: string;
  name: string;
  approved: number;
  notApproved: number;
  /** Approved cases already in Jira (in the project the plan was last sent to). */
  sent: number;
  defaultProject: string;
  epicKey: string | null;
  disabled?: boolean;
  className: string;
}) {
  const [jiraProject, setJiraProject] = useState(defaultProject);
  const key = jiraProject.trim().toUpperCase();
  const valid = /^[A-Z][A-Z0-9_]{0,19}$/.test(key);
  const sameProject = !!epicKey && epicKey.startsWith(`${key}-`);
  const updates = sameProject ? sent : 0;
  const creates = approved - updates;
  const inputId = `jira-project-${trackId}`;
  return (
    <ConfirmAction
      action={sendToJira}
      fields={{ projectId, trackId }}
      label={epicKey ? "Send to Jira again" : "Send to Jira"}
      className={className}
      disabled={disabled || !approved}
      title={approved ? undefined : "Approve test cases in Review first"}
      heading={`Send ${code} · ${name} to Jira`}
      subtitle={`${approved} approved ${approved === 1 ? "test case" : "test cases"}`}
      confirmLabel={valid ? `Send to ${key}` : "Send"}
      confirmDisabled={!valid}
      points={[
        sameProject ? <>The plan&apos;s Epic, <strong>{epicKey}</strong>, is updated.</> : <>An Epic, <strong>{code} {name}: test plan</strong>, is created with the plan&apos;s scope and risk areas.</>,
        creates > 0 && <>{creates} approved {creates === 1 ? "test case becomes a Task" : "test cases become Tasks"} under it, with steps, expected results, the user story, scenario and requirements, and a link back here.</>,
        updates > 0 && <>{updates} {updates === 1 ? "Task sent before is" : "Tasks sent before are"} updated. Summary, description and priority are replaced with what&apos;s here; statuses, assignees and comments in Jira are left alone.</>,
        notApproved > 0 && <>{notApproved} {notApproved === 1 ? "test case isn't" : "test cases aren't"} approved yet and {notApproved === 1 ? "stays" : "stay"} out.</>,
        epicKey && !sameProject && valid && <>This plan was last sent to {epicKey.split("-")[0]}. Sending to {key} creates a new Epic and Tasks there; the ones in {epicKey.split("-")[0]} stay as they are.</>,
        <>Labelled <code>mattertest</code> and <code>{code}</code>. No Claude calls, so no cost.</>,
      ]}
    >
      <div className="field">
        <label htmlFor={inputId}>Jira project key</label>
        <input
          id={inputId}
          name="jiraProject"
          className="input"
          value={jiraProject}
          onChange={(e) => setJiraProject(e.target.value.toUpperCase())}
          placeholder="DEBRA"
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={jiraProject !== "" && !valid}
          style={{ maxWidth: 220, textTransform: "uppercase" }}
        />
        <span className="hint small">The letters before the number in an issue key: DEBRA for DEBRA-123.</span>
      </div>
    </ConfirmAction>
  );
}
