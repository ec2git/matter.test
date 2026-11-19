import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { currentPlan, liveRequirements, passageLabel, passages, projectSources, projectTracks, sourceTitle, type Passage, type PlanTree, type RequirementRow } from "@/lib/assets";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { KIND_LABEL, REVIEW_LABEL, clock, planCode, planKey, plural } from "@/lib/format";
import { reviewItem } from "../assets/actions";
import { StepsEditor } from "./StepsEditor";

export const dynamic = "force-dynamic";

type Kind = "tc" | "req" | "plan" | "story" | "scenario";
/** Inbox type filter, in the order items are listed. */
const TYPE_FILTERS: { kind: Kind; label: string }[] = [
  { kind: "plan", label: "Test plan" },
  { kind: "req", label: "Requirements" },
  { kind: "story", label: "User stories" },
  { kind: "scenario", label: "Scenarios" },
  { kind: "tc", label: "Test cases" },
];

type Item = { kind: Kind; id: string; trackId: string; label: string; title: string; meta: string; state: string };

function Trace({ items, empty }: { items: Passage[]; empty: string }) {
  return (
    <div className="trace">
      <span className="trace-label">Traced to source</span>
      {!items.length && <span className="small muted">{empty}</span>}
      {items.map((p) => (
        <div key={p.id} className="stack" style={{ gap: 6 }}>
          <blockquote className="quote">{p.text.length > 700 ? `${p.text.slice(0, 700)}…` : p.text}</blockquote>
          <span className="quote-cite">
            <Link href={p.href}>{passageLabel(p)}</Link>
            {p.videoHref && <a href={p.videoHref} target="_blank" rel="noreferrer">Watch at {clock(p.locator.startSec ?? 0)}</a>}
            {p.pageHref && <a href={p.pageHref} target="_blank" rel="noreferrer">Open in Confluence</a>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Decide({ kind, id, state, editHref }: { kind: Kind; id: string; state: string; editHref?: string }) {
  const decided = state !== "needs-review" && state !== "draft";
  return (
    <form action={reviewItem} className="actions">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      {decided ? (
        <button type="submit" name="decision" value="needs-review" className="btn btn-outline">Reopen</button>
      ) : (
        <>
          <button type="submit" name="decision" value="rejected" className="btn btn-danger">Reject</button>
          {editHref && <Link className="btn btn-outline" href={editHref}>Edit steps</Link>}
          <button type="submit" name="decision" value="approved" className="btn">Approve</button>
        </>
      )}
    </form>
  );
}

export default async function ReviewInbox({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ item?: string; edit?: string; show?: string; type?: string; plan?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await projectWithClient(id);
  if (!row) notFound();
  const { project, client } = row;
  const showAll = sp.show === "all";
  const type = TYPE_FILTERS.find((t) => t.kind === sp.type)?.kind;

  const [tracks, srcs, latest] = await Promise.all([projectTracks(id), projectSources(id), latestSiteCheck(id)]);
  const many = tracks.length > 1;
  // Each test plan's current version and requirements; the inbox lists them all, or one plan's with the filter.
  const bundles = await Promise.all(
    tracks.map(async (track) => {
      const [tree, reqs] = await Promise.all([currentPlan(track.id), liveRequirements(id, track.id)]);
      return { track, tree, reqs, cases: tree?.scenarios.flatMap((sc) => sc.cases.map((c) => ({ ...c, scenario: sc }))) ?? [] };
    }),
  );
  type Bundle = (typeof bundles)[number];
  // An item opened from a test plan (or any link without a plan) filters the inbox to that item's plan.
  // "plan=all" keeps every plan listed, so picking an item from the full list doesn't narrow it.
  const itemId = (sp.item ?? "").split(":")[1];
  const itemTrack = itemId
    ? bundles.find((b) => b.tree?.plan.id === itemId || b.reqs.some((r) => r.id === itemId) || b.tree?.stories.some((x) => x.id === itemId) || b.tree?.scenarios.some((x) => x.id === itemId || x.cases.some((c) => c.id === itemId)))?.track.id
    : undefined;
  const planFilter = sp.plan === "all" ? undefined : (tracks.find((t) => t.id === sp.plan)?.id ?? (many ? itemTrack : undefined));
  const pending = (state: string) => showAll || state === "needs-review" || state === "draft";
  type Scen = PlanTree["scenarios"][number];
  /** A scenario has no review state of its own: it's waiting while any of its cases is, decided when all are. */
  const scenarioState = (sc: Scen) => {
    const states = new Set(sc.cases.map((c) => c.reviewState).filter((x) => x !== "superseded"));
    if (!states.size || states.has("needs-review")) return "needs-review";
    return states.size === 1 ? [...states][0]! : "mixed";
  };
  /** IDs as shown: TP1-REQ-01. */
  const bk = (b: Bundle, key: string | null | undefined) => (key ? planKey(b.track.number, key) : "");
  /** With several test plans, each item says which one it belongs to. */
  const inPlan = (b: Bundle, meta: string) => (many ? [b.track.name, meta].filter(Boolean).join(" · ") : meta);
  const reqItem = (b: Bundle, r: RequirementRow): Item => ({ kind: "req", id: r.id, trackId: b.track.id, label: `Requirement · ${bk(b, r.key)}`, title: r.title, meta: inPlan(b, [r.area, plural(r.acceptanceCriteria.length, "acceptance criterion", "acceptance criteria")].filter(Boolean).join(" · ")), state: r.reviewState });
  const storyItem = (b: Bundle, st: PlanTree["stories"][number]): Item => ({ kind: "story", id: st.id, trackId: b.track.id, label: `User story · ${bk(b, st.key)}`, title: st.title, meta: inPlan(b, `${st.priority}${st.critical ? " · critical" : ""} · ${plural(b.tree!.scenarios.filter((x) => x.storyId === st.id).length, "scenario")}`), state: st.reviewState });
  const scenarioItem = (b: Bundle, sc: Scen): Item => ({
    kind: "scenario",
    id: sc.id,
    trackId: b.track.id,
    label: `Scenario${sc.key ? ` · ${bk(b, sc.key)}` : ""}`,
    title: sc.title,
    meta: inPlan(b, [`${sc.priority} ${KIND_LABEL[sc.kind] ?? sc.kind}`, sc.storyId ? bk(b, b.tree?.stories.find((st) => st.id === sc.storyId)?.key) : null, sc.cases.length ? `${plural(sc.cases.length, "case")}: ${sc.cases.map((c) => bk(b, c.key)).join(", ")}` : "no cases"].filter(Boolean).join(" · ")),
    state: scenarioState(sc),
  });
  const caseItem = (b: Bundle, c: Bundle["cases"][number]): Item => ({ kind: "tc", id: c.id, trackId: b.track.id, label: `Test case · ${bk(b, c.key)}`, title: c.title, meta: inPlan(b, `${plural(c.steps.length, "step")} · ${c.scenario.key ? `${bk(b, c.scenario.key)} · ` : ""}${c.scenario.priority} ${KIND_LABEL[c.scenario.kind] ?? ""}${c.automationCandidate ? " · automation candidate" : ""}`), state: c.reviewState });
  const planItem = (b: Bundle): Item => ({ kind: "plan", id: b.tree!.plan.id, trackId: b.track.id, label: many ? `Test plan · ${b.track.name}` : "Test plan", title: `${b.tree!.plan.name}, version ${b.tree!.plan.version}`, meta: `${plural(b.tree!.plan.body?.risks.length ?? 0, "risk area")} · ${plural(b.tree!.scenarios.length, "scenario")}`, state: b.tree!.plan.status });

  const all: Item[] = [];
  // Order: plans, then requirements, user stories, scenarios and test cases — the order things were derived in.
  for (const b of bundles) if (b.tree && pending(b.tree.plan.status)) all.push(planItem(b));
  for (const b of bundles) for (const r of b.reqs) if (pending(r.reviewState)) all.push(reqItem(b, r));
  for (const b of bundles) for (const st of b.tree?.stories ?? []) if (pending(st.reviewState)) all.push(storyItem(b, st));
  for (const b of bundles) for (const sc of b.tree?.scenarios ?? []) if (pending(scenarioState(sc))) all.push(scenarioItem(b, sc));
  for (const b of bundles) for (const c of b.cases) if (pending(c.reviewState)) all.push(caseItem(b, c));
  const planCounts = new Map(tracks.map((t) => [t.id, all.filter((i) => i.trackId === t.id).length]));
  const items = planFilter ? all.filter((i) => i.trackId === planFilter) : all;

  const [selKind, selId] = (sp.item ?? "").split(":") as [Kind | undefined, string | undefined];
  // The filters narrow the list; an item opened from elsewhere (a link in the detail) still shows on the right.
  const counts = new Map(TYPE_FILTERS.map((t) => [t.kind, items.filter((i) => i.kind === t.kind).length]));
  const shown = type ? items.filter((i) => i.kind === type) : items;
  const sel = shown.find((i) => i.kind === selKind && i.id === selId) ?? (selKind && selId ? findAny(selKind, selId) : undefined) ?? shown[0];
  function findAny(kind: Kind, itemId: string): Item | undefined {
    for (const b of bundles) {
      if (kind === "tc") {
        const c = b.cases.find((x) => x.id === itemId);
        if (c) return caseItem(b, c);
      } else if (kind === "scenario") {
        const sc = b.tree?.scenarios.find((x) => x.id === itemId);
        if (sc) return scenarioItem(b, sc);
      } else if (kind === "story") {
        const st = b.tree?.stories.find((x) => x.id === itemId);
        if (st) return storyItem(b, st);
      } else if (kind === "req") {
        const r = b.reqs.find((x) => x.id === itemId);
        if (r) return reqItem(b, r);
      } else if (b.tree?.plan.id === itemId) return planItem(b);
    }
    return undefined;
  }
  const query = (o: { show?: boolean; type?: Kind; plan?: string; item?: string }) => {
    const q = new URLSearchParams();
    if (o.show) q.set("show", "all");
    if (o.plan) q.set("plan", o.plan);
    if (o.type) q.set("type", o.type);
    if (o.item) q.set("item", o.item);
    const str = q.toString();
    return `/projects/${id}/review${str ? `?${str}` : ""}`;
  };
  const hrefOf = (i: Pick<Item, "kind" | "id">) => query({ show: showAll, type, plan: planFilter ?? (many ? "all" : undefined), item: `${i.kind}:${i.id}` });

  // The selected item's test plan: the detail below reads its plan tree and requirements.
  const selBundle = bundles.find((b) => b.track.id === sel?.trackId);
  const tree = selBundle?.tree ?? null;
  const reqs = selBundle?.reqs ?? [];
  const cases = selBundle?.cases ?? [];
  const reqByKey = new Map(reqs.map((r) => [r.key, r]));
  const K = (key: string | null | undefined) => (selBundle && key ? bk(selBundle, key) : (key ?? ""));

  // Detail data for the selected item.
  const selCase = sel?.kind === "tc" ? cases.find((c) => c.id === sel.id) : undefined;
  const selReq = sel?.kind === "req" ? reqs.find((r) => r.id === sel.id) : undefined;
  const selStory = sel?.kind === "story" ? tree?.stories.find((x) => x.id === sel.id) : undefined;
  const selScenario = sel?.kind === "scenario" ? tree?.scenarios.find((x) => x.id === sel.id) : undefined;
  const scenarioReqs: RequirementRow[] = selScenario ? selScenario.requirementIds.map((k) => reqByKey.get(k)).filter((r): r is RequirementRow => !!r) : [];
  const storyOfScenario = selScenario?.storyId ? tree?.stories.find((x) => x.id === selScenario.storyId) : undefined;
  const storyReqs: RequirementRow[] = selStory ? selStory.requirementIds.map((k) => reqByKey.get(k)).filter((r): r is RequirementRow => !!r) : [];
  const storyScenarios = selStory ? (tree?.scenarios.filter((x) => x.storyId === selStory.id) ?? []) : [];
  const storyOfCase = selCase?.scenario.storyId ? tree?.stories.find((x) => x.id === selCase.scenario.storyId) : undefined;
  const caseReqs: RequirementRow[] = selCase ? selCase.scenario.requirementIds.map((k) => reqByKey.get(k)).filter((r): r is RequirementRow => !!r) : [];
  const traceIds = selCase
    ? selCase.sourceChunkIds.length
      ? selCase.sourceChunkIds
      : caseReqs.flatMap((r) => r.sourceChunkIds)
    : selReq
      ? selReq.sourceChunkIds
      : selScenario
        ? [...new Set(selScenario.cases.flatMap((c) => c.sourceChunkIds))]
        : storyReqs.flatMap((r) => r.sourceChunkIds.slice(0, 1));
  const trace = await passages(traceIds.slice(0, 4));
  const editing = sp.edit === "1" && !!selCase;

  return (
    <Shell active="review" project={{ id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href={`/projects/${id}`}>{client.name}</Link> / Review inbox</span>
          <h1>Review inbox</h1>
          <span className="muted">Everything the agent drafted that needs a human yes or no. Each item links back to the passage it came from.</span>
        </div>
        <nav className="tabs" aria-label="Show">
          <Link className="tab" href={query({ type, plan: planFilter })} aria-current={!showAll ? "page" : undefined}>To review</Link>
          <Link className="tab" href={query({ show: true, type, plan: planFilter })} aria-current={showAll ? "page" : undefined}>Everything</Link>
        </nav>
      </div>

      {many && all.length > 0 && (
        <nav className="type-filter" aria-label="Filter by test plan">
          <span className="small muted filter-label">Test plan</span>
          <Link className="chip" href={query({ show: showAll, type })} aria-current={!planFilter ? "page" : undefined}>
            All plans <span className="chip-count">{all.length}</span>
          </Link>
          {tracks.map((t) => (
            <Link key={t.id} className="chip" href={query({ show: showAll, type, plan: t.id })} aria-current={planFilter === t.id ? "page" : undefined}>
              {planCode(t.number)} · {t.name} <span className="chip-count">{planCounts.get(t.id) ?? 0}</span>
            </Link>
          ))}
        </nav>
      )}

      {items.length > 0 && (
        <nav className="type-filter" aria-label="Filter by type">
          {many && <span className="small muted filter-label">Type</span>}
          <Link className="chip" href={query({ show: showAll, plan: planFilter })} aria-current={!type ? "page" : undefined}>
            Show all <span className="chip-count">{items.length}</span>
          </Link>
          {TYPE_FILTERS.map((t) => (
            <Link key={t.kind} className="chip" href={query({ show: showAll, type: t.kind, plan: planFilter })} aria-current={type === t.kind ? "page" : undefined}>
              {t.label} <span className="chip-count">{counts.get(t.kind) ?? 0}</span>
            </Link>
          ))}
        </nav>
      )}

      {!sel ? (
        <div className="empty">
          {type && items.length ? `No ${TYPE_FILTERS.find((t) => t.kind === type)!.label.toLowerCase()} ${showAll ? "yet" : "waiting for review"}.` : planFilter && all.length ? `Nothing in ${tracks.find((t) => t.id === planFilter)!.name} ${showAll ? "yet" : "waiting for review"}.` : bundles.some((b) => b.tree || b.reqs.length) ? "Nothing waiting for review." : <>Nothing to review yet. <Link href={`/projects/${id}/assets`}>Add a source</Link> and the agent will draft requirements and test cases.</>}
        </div>
      ) : (
        <div className="review-layout">
          <section className="review-list" aria-label="Items to review">
            <span className="small muted">{plural(shown.length, showAll ? "item" : "item to review", showAll ? "items" : "items to review")}</span>
            {!shown.length && <span className="small muted">No {TYPE_FILTERS.find((t) => t.kind === type)?.label.toLowerCase()} {showAll ? "yet" : "waiting for review"}.</span>}
            {shown.map((i) => (
              <Link key={`${i.kind}:${i.id}`} className="review-item" href={hrefOf(i)} aria-current={i.kind === sel.kind && i.id === sel.id ? "true" : undefined}>
                <span className="row"><span className="review-kind">{i.label}</span><span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>{REVIEW_LABEL[i.state] ?? i.state}</span></span>
                <span className="review-title">{i.title}</span>
                <span className="review-meta">{i.meta}</span>
              </Link>
            ))}
          </section>

          <section className="review-detail panel" style={{ gap: 16, padding: 24 }}>
            {selCase && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">
                      {K(selCase.key)}
                      {storyOfCase ? <> · <Link href={hrefOf({ kind: "story", id: storyOfCase.id })}>{K(storyOfCase.key)} {storyOfCase.title}</Link></> : null} · {selCase.scenario.key ? `${K(selCase.scenario.key)} ` : ""}{selCase.scenario.title} ({selCase.scenario.priority}, {KIND_LABEL[selCase.scenario.kind]})
                    </span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selCase.title}</h2>
                    {selCase.scenario.situation && (
                      <span className="small" style={{ color: "var(--ink-2)" }}>
                        {selCase.scenario.actor ? <strong>{selCase.scenario.actor}</strong> : null}{selCase.scenario.actor ? " " : ""}{selCase.scenario.situation}
                        {selCase.scenario.outcome ? <> → {selCase.scenario.outcome}</> : null}
                      </span>
                    )}
                  </div>
                  <span className={`pill status-${selCase.reviewState}`}>{REVIEW_LABEL[selCase.reviewState]}{selCase.edited ? " · edited" : ""}</span>
                </div>
                {editing ? (
                  <StepsEditor id={selCase.id} title={selCase.title} preconditions={selCase.preconditions} testData={selCase.testData} steps={selCase.steps} doneHref={hrefOf({ kind: "tc", id: selCase.id })} />
                ) : (
                  <>
                    <div className="kv">
                      <div><span className="kv-label">Preconditions</span><span>{selCase.preconditions || "None"}</span></div>
                      <div><span className="kv-label">Test data</span><span>{selCase.testData || "None"}</span></div>
                    </div>
                    <div className="table-wrap" style={{ border: 0 }}>
                      <table style={{ minWidth: 560 }}>
                        <thead><tr><th style={{ width: 32 }}>#</th><th>Action</th><th>Expected result</th></tr></thead>
                        <tbody>
                          {selCase.steps.map((s, i) => <tr key={i}><td className="muted">{i + 1}</td><td>{s.action}</td><td>{s.expected}</td></tr>)}
                        </tbody>
                      </table>
                    </div>
                    {caseReqs.length > 0 && (
                      <div className="stack" style={{ gap: 4 }}>
                        <span className="kv-label">Covers</span>
                        {caseReqs.map((r) => <Link key={r.id} className="small" href={hrefOf({ kind: "req", id: r.id })}>{K(r.key)} {r.title}</Link>)}
                      </div>
                    )}
                    <Trace items={trace} empty="No passage recorded for this case." />
                    <Decide kind="tc" id={selCase.id} state={selCase.reviewState} editHref={`${hrefOf({ kind: "tc", id: selCase.id })}&edit=1`} />
                  </>
                )}
              </>
            )}

            {selScenario && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">
                      Scenario{selScenario.key ? ` · ${K(selScenario.key)}` : ""}
                      {storyOfScenario ? <> · <Link href={hrefOf({ kind: "story", id: storyOfScenario.id })}>{K(storyOfScenario.key)} {storyOfScenario.title}</Link></> : null}
                    </span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selScenario.title}</h2>
                  </div>
                  <span className={`pill status-${scenarioState(selScenario)}`}>{REVIEW_LABEL[scenarioState(selScenario)]}</span>
                </div>
                <span className="row" style={{ gap: 6 }}>
                  <span className={`pill kind-${selScenario.kind}`}>{KIND_LABEL[selScenario.kind] ?? selScenario.kind}</span>
                  <span className="pill prio">{selScenario.priority}</span>
                </span>
                {selScenario.situation && (
                  <p className="story-text">
                    {selScenario.actor && <strong>{selScenario.actor}: </strong>}
                    {selScenario.situation}
                    {selScenario.outcome && <> → {selScenario.outcome}</>}
                  </p>
                )}
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Covers</span>
                  {scenarioReqs.map((r) => (
                    <Link key={r.id} className="small" href={hrefOf({ kind: "req", id: r.id })}>{K(r.key)} {r.title}</Link>
                  ))}
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <span className="kv-label">Test cases</span>
                  {selScenario.cases.map((c) => (
                    <span key={c.id} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start", justifyContent: "space-between" }}>
                      <Link href={hrefOf({ kind: "tc", id: c.id })}>{K(c.key)} {c.title}</Link>
                      <span className={`pill status-${c.reviewState}`}>{REVIEW_LABEL[c.reviewState]}{c.edited ? " · edited" : ""}</span>
                    </span>
                  ))}
                </div>
                <Trace items={trace} empty="No passage recorded." />
                <p className="small muted" style={{ margin: 0 }}>Approving or rejecting the scenario applies to all {plural(selScenario.cases.length, "test case")}. Open a test case to review or edit it on its own.</p>
                <Decide kind="scenario" id={selScenario.id} state={scenarioState(selScenario) === "mixed" ? "approved" : scenarioState(selScenario)} />
              </>
            )}

            {selStory && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">User story · {K(selStory.key)} · {selStory.priority}{selStory.critical ? " · critical" : ""}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selStory.title}</h2>
                  </div>
                  <span className={`pill status-${selStory.reviewState}`}>{REVIEW_LABEL[selStory.reviewState]}</span>
                </div>
                <p className="story-text">
                  <strong>As a</strong> {selStory.actor}, <strong>I want to</strong> {selStory.want}
                  {selStory.soThat ? <>, <strong>so that</strong> {selStory.soThat}</> : null}.
                </p>
                {selStory.critical && selStory.criticalWhy && <span className="small" style={{ color: "var(--ink-2)" }}>Why it&apos;s critical: {selStory.criticalWhy}</span>}
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Acceptance criteria</span>
                  {selStory.acceptanceCriteria.length ? <ul className="ul">{selStory.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul> : <span className="small muted">None stated.</span>}
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Covers</span>
                  {storyReqs.map((r) => (
                    <Link key={r.id} className="small" href={hrefOf({ kind: "req", id: r.id })}>{K(r.key)} {r.title}</Link>
                  ))}
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <span className="kv-label">Scenarios</span>
                  {storyScenarios.map((x) => (
                    <span key={x.id} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                      <span className={`pill kind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                      <span>{x.key ? `${K(x.key)} · ` : ""}{x.title} · {x.priority} · {plural(x.cases.length, "case")}</span>
                    </span>
                  ))}
                  {!storyScenarios.length && <span className="small muted">None yet.</span>}
                </div>
                <Trace items={trace} empty="No passage recorded." />
                <Decide kind="story" id={selStory.id} state={selStory.reviewState} />
              </>
            )}

            {selReq && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">{[K(selReq.key), selReq.area].filter(Boolean).join(" · ")}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selReq.title}</h2>
                  </div>
                  <span className={`pill status-${selReq.reviewState}`}>{REVIEW_LABEL[selReq.reviewState]}</span>
                </div>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{selReq.text}</p>
                {selReq.acceptanceCriteria.length > 0 && (
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="kv-label">Acceptance criteria</span>
                    <ul className="ul">{selReq.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </div>
                )}
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Scenarios in the current plan</span>
                  {tree?.scenarios.filter((s) => s.requirementIds.includes(selReq.key)).map((s) => (
                    <span key={s.id} className="small">{s.key ? `${K(s.key)} · ` : ""}{s.title} · {KIND_LABEL[s.kind] ?? s.kind} · {plural(s.cases.length, "case")}</span>
                  ))}
                  {!tree?.scenarios.some((s) => s.requirementIds.includes(selReq.key)) && <span className="small muted">None yet.</span>}
                </div>
                <Trace items={trace} empty="No passage recorded." />
                <p className="small muted" style={{ margin: 0 }}>Rejecting a requirement leaves it out of the next draft of {many && selBundle ? selBundle.track.name : "the plan"} (Test assets › Draft again).</p>
                <Decide kind="req" id={selReq.id} state={selReq.reviewState} />
              </>
            )}

            {sel.kind === "plan" && tree && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">Test plan · version {tree.plan.version}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{tree.plan.name}</h2>
                  </div>
                  <span className={`pill status-${tree.plan.status}`}>{REVIEW_LABEL[tree.plan.status] ?? tree.plan.status}</span>
                </div>
                {tree.plan.body?.summary && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{tree.plan.body.summary}</p>}
                <div className="kv">
                  <div><span className="kv-label">In scope</span><ul className="ul">{tree.plan.body?.scope.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  <div><span className="kv-label">Out of scope</span><ul className="ul">{tree.plan.body?.outOfScope.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Risk ranking</span>
                  {tree.plan.body?.risks.map((r, i) => <span key={i} className="small"><b>{r.priority}</b> {r.area}: {r.why}</span>)}
                </div>
                <div className="trace">
                  <span className="trace-label">Built from</span>
                  {srcs.filter((s) => tree.plan.sourceIds.includes(s.id)).map((s) => <Link key={s.id} className="small" href={`/sources/${s.id}`}>{sourceTitle(s)}</Link>)}
                  <span className="small muted">{plural(reqs.filter((r) => r.reviewState !== "rejected").length, "requirement")} · <Link href={`/projects/${id}/assets?plan=${selBundle!.track.id}`}>See the full plan</Link></span>
                </div>
                <Decide kind="plan" id={tree.plan.id} state={tree.plan.status} />
              </>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
