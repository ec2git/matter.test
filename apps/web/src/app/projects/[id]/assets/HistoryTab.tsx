import Link from "next/link";
import type { PlanTree, PlanVersionRow } from "@/lib/assets";
import { KIND_LABEL, REVIEW_LABEL, plural, usd } from "@/lib/format";

const fmtDate = (d: Date) => d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const secs = (n: number) => (n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`);

/** What changed from the version before, by scenario and test case title. Approved cases move into later versions. */
function changes(cur: PlanVersionRow, prev: PlanVersionRow | undefined) {
  if (!prev) return null;
  const had = new Set(prev.scenarioTitles.map(norm));
  const has = new Set(cur.scenarioTitles.map(norm));
  const hadCases = new Set(prev.cases.map((c) => norm(c.title)));
  const hasCases = new Set(cur.cases.map((c) => norm(c.title)));
  const carried = cur.cases.filter((c) => c.reviewState === "approved" && !hadCases.has(norm(c.title)));
  return {
    scenariosAdded: cur.scenarioTitles.filter((t) => !had.has(norm(t))),
    scenariosRemoved: prev.scenarioTitles.filter((t) => !has.has(norm(t))),
    casesAdded: cur.cases.filter((c) => !hadCases.has(norm(c.title)) && c.reviewState !== "approved").map((c) => c.title),
    casesRemoved: prev.cases.filter((c) => !hasCases.has(norm(c.title))).map((c) => c.title),
    carried: carried.length,
  };
}

function Names({ label, names }: { label: string; names: string[] }) {
  if (!names.length) return null;
  return (
    <details className="small">
      <summary style={{ cursor: "pointer" }}>{label}</summary>
      <ul className="ul small" style={{ margin: "4px 0 0" }}>
        {names.slice(0, 12).map((n, i) => <li key={i}>{n}</li>)}
        {names.length > 12 && <li className="muted">and {names.length - 12} more</li>}
      </ul>
    </details>
  );
}

/** Every version of a test plan, newest first, with why it was drafted and what changed. */
export function HistoryList({ history, versionHref }: { history: PlanVersionRow[]; versionHref: (v: number) => string }) {
  if (!history.length) return <div className="empty">Not drafted yet.</div>;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="small muted">
        Every draft of this plan is kept. Approved user stories and test cases move into each new version, so they show under the newest one; everything else stays with the version it was drafted in.
      </span>
      {history.map((h, i) => {
        const ch = changes(h, history[i + 1]);
        const current = h.status !== "superseded";
        return (
          <article key={h.id} className="panel" style={{ gap: 8 }} aria-labelledby={`v-${h.version}`}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="row" style={{ gap: 8, alignItems: "center" }}>
                <h3 id={`v-${h.version}`} style={{ fontSize: 15, margin: 0 }}>Version {h.version}</h3>
                <span className={`pill status-${h.status}`}>{current ? (REVIEW_LABEL[h.status] ?? h.status) : "Superseded"}</span>
                {current && <span className="small muted">current</span>}
              </span>
              <Link className="btn btn-outline btn-sm" href={versionHref(h.version)}>{current ? "View" : "View this version"}</Link>
            </div>
            <span className="small" style={{ color: "var(--ink-2)" }}>
              {[h.reason, fmtDate(h.createdAt), h.requestedBy ? `by ${h.requestedBy}` : null, h.costUsd ? usd(h.costUsd) : null, h.durationSec ? secs(h.durationSec) : null].filter(Boolean).join(" · ")}
            </span>
            {h.status === "approved" && h.reviewedAt && <span className="small">Approved{h.reviewedBy ? ` by ${h.reviewedBy}` : ""} on {fmtDate(h.reviewedAt)}</span>}
            <span className="facts-line">{[plural(h.stories, "user story", "user stories"), plural(h.scenarioTitles.length, "scenario"), plural(h.cases.length, "test case"), plural(h.critical.length, "critical requirement")].join(" · ")}</span>
            {ch ? (
              <div className="stack" style={{ gap: 4 }}>
                <span className="small">
                  Changes from version {history[i + 1]!.version}:{" "}
                  {[
                    ch.scenariosAdded.length ? `${ch.scenariosAdded.length} new ${ch.scenariosAdded.length === 1 ? "scenario" : "scenarios"}` : null,
                    ch.scenariosRemoved.length ? `${ch.scenariosRemoved.length} dropped` : null,
                    ch.casesAdded.length ? `${plural(ch.casesAdded.length, "new test case")}` : null,
                    ch.casesRemoved.length ? `${plural(ch.casesRemoved.length, "test case")} dropped` : null,
                    ch.carried ? `${plural(ch.carried, "approved test case")} carried over` : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || "same scenarios and test cases"}
                  .
                </span>
                <Names label="New scenarios" names={ch.scenariosAdded} />
                <Names label="Dropped scenarios" names={ch.scenariosRemoved} />
                <Names label="New test cases" names={ch.casesAdded} />
                <Names label="Dropped test cases" names={ch.casesRemoved} />
              </div>
            ) : (
              <span className="small muted">The first draft.</span>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** One old version, read-only: its plan text and what it still holds. */
export function VersionView({ tree, backHref, K, KT }: { tree: PlanTree; backHref: string; K: (key: string) => string; KT: (text: string) => string }) {
  const { plan, stories, scenarios } = tree;
  const body = plan.body;
  const loose = scenarios.filter((s) => !s.storyId || !stories.some((st) => st.id === s.storyId));
  const groups = [...stories.map((st) => ({ story: st as (typeof stories)[number] | null, list: scenarios.filter((s) => s.storyId === st.id) })), ...(loose.length ? [{ story: null, list: loose }] : [])];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Link href={backHref} className="small">← All versions</Link>
      <div className="panel" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <h2 style={{ fontSize: 16 }}>{plan.name}, version {plan.version}</h2>
          <span className={`pill status-${plan.status}`}>{plan.status === "superseded" ? "Superseded" : (REVIEW_LABEL[plan.status] ?? plan.status)}</span>
        </div>
        <p className="banner" role="note" style={{ margin: 0 }}>
          {plan.status === "superseded" ? "A past version, shown read-only. " : ""}Approved stories and test cases moved into later versions show there, not here. Requirement IDs are as they were when this version was drafted; reading a source again renumbers them.
        </p>
        {body?.summary && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{KT(body.summary)}</p>}
        <div className="kv">
          <div><h3>In scope</h3><ul className="ul">{body?.scope.map((s, i) => <li key={i}>{KT(s)}</li>)}</ul></div>
          <div><h3>Out of scope</h3>{body?.outOfScope.length ? <ul className="ul">{body.outOfScope.map((s, i) => <li key={i}>{KT(s)}</li>)}</ul> : <span className="muted">Nothing stated</span>}</div>
        </div>
        {!!body?.risks.length && (
          <>
            <h3>Risk-ranked areas</h3>
            <div className="table-wrap" style={{ border: 0 }}>
              <table style={{ minWidth: 560 }}>
                <thead><tr><th>Area</th><th>Risk</th><th>Why</th><th>Priority</th></tr></thead>
                <tbody>
                  {body.risks.map((r, i) => (
                    <tr key={i}><td style={{ fontWeight: 600 }}>{r.area}</td><td>{r.risk[0]!.toUpperCase() + r.risk.slice(1)}</td><td style={{ color: "var(--ink-2)" }}>{KT(r.why)}</td><td><span className="pill prio">{r.priority}</span></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!!body?.critical?.length && (
          <>
            <h3>Critical requirements</h3>
            <ul className="ul">{body.critical.map((c) => <li key={c.key}><strong>{K(c.key)}</strong>: {KT(c.why)}</li>)}</ul>
          </>
        )}
      </div>
      <h3 style={{ fontSize: 15 }}>{[plural(stories.length, "user story", "user stories"), plural(scenarios.length, "scenario"), plural(scenarios.reduce((n, s) => n + s.cases.length, 0), "test case")].join(" · ")} still in this version</h3>
      {groups.filter((g) => g.list.length || g.story).map((g) => (
        <section key={g.story?.id ?? "none"} className="panel" style={{ padding: 0, gap: 0 }}>
          <h4 className="group-head">{g.story ? <>{g.story.key ? `${K(g.story.key)} · ` : ""}{g.story.title}</> : "Not linked to a story"}</h4>
          {!g.list.length && <span className="small muted" style={{ padding: "12px 18px" }}>No scenarios left in this version.</span>}
          {g.list.map((s) => (
            <div key={s.id} className="stack" style={{ gap: 6, padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
              <span className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{s.key && <span className="muted" style={{ fontWeight: 500 }}>{K(s.key)} · </span>}{s.title}</span>
                <span className="row" style={{ gap: 6 }}><span className="pill prio">{s.priority}</span><span className={`pill kind-${s.kind}`}>{KIND_LABEL[s.kind] ?? s.kind}</span></span>
              </span>
              {s.cases.map((c) => (
                <details key={c.id} className="small">
                  <summary style={{ cursor: "pointer" }}>
                    <span className="muted">{K(c.key)} · </span>{c.title} <span className="muted">· {REVIEW_LABEL[c.reviewState] ?? c.reviewState}</span>
                  </summary>
                  <ol className="ul small" style={{ margin: "6px 0 0" }}>
                    {c.steps.map((st, i) => <li key={i}>{st.action}{st.expected ? <span className="muted"> → {st.expected}</span> : null}</li>)}
                  </ol>
                </details>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
