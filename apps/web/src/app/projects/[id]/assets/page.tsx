import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { RunStatus } from "@/components/badges";
import { RunProgress, type Progress } from "@/components/RunProgress";
import { agentRuns, currentPlan, liveRequirements, passages, projectQuestions, projectSources, projectTracks, removedSources, sourceTitle, type AgentRun, type PlanTree, type SourceRow, type TrackRow } from "@/lib/assets";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { KIND_LABEL, REVIEW_LABEL, planCode, planKey, SOURCE_STATUS_LABEL, SOURCE_TYPE_LABEL, clock, duration, plural, timeAgo, usd } from "@/lib/format";
import { checkConfluence, removeSource, restoreSource, retrySource, updateQuestion } from "./actions";
import { AddSource, AgentInstructions, AttachTranscript, AutoRefresh } from "./SourceForms";
import { DeletePlan, DraftAgain, EditPlan, NewPlanForm } from "./PlanForms";
import { ConfirmAction } from "@/components/ConfirmAction";

export const dynamic = "force-dynamic";

const TABS = ["plan", "requirements", "stories", "scenarios", "cases", "coverage", "questions"] as const;
type Tab = (typeof TABS)[number];

function sourceDetail(s: SourceRow, inGroup = false): string {
  const m = s.meta;
  return [
    inGroup ? null : (SOURCE_TYPE_LABEL[s.type] ?? s.type),
    s.version > 1 ? `version ${s.version}` : null,
    inGroup ? null : m.confluence?.rootKind === "folder" ? "from a folder" : m.confluence && m.confluence.pageId !== m.confluence.rootPageId ? "child page" : null,
    inGroup ? null : m.confluence?.includeChildren ? "with child pages" : null,
    m.pages ? plural(m.pages, "page") : null,
    m.durationSec ? clock(m.durationSec) : null,
    m.owner ? `by ${m.owner}` : null,
    m.chunks ? plural(m.chunks, "passage") : null,
    m.transcriptFrom === "upload" ? "transcript uploaded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Confluence pages added together (a folder, or a page with its child pages), shown as one collapsible group. */
type SourceGroup = { key: string; title: string; kind: "folder" | "page"; href: string | null; members: SourceRow[] };

/** The sources list: single sources as they are, and pages read through a folder or parent page grouped under it. */
function groupSources(srcs: SourceRow[]): ({ kind: "one"; source: SourceRow } | { kind: "group"; group: SourceGroup })[] {
  const out: ({ kind: "one"; source: SourceRow } | { kind: "group"; group: SourceGroup })[] = [];
  const groups = new Map<string, SourceGroup>();
  for (const s of srcs) {
    const c = s.meta.confluence;
    const grouped = c && (c.rootKind === "folder" || c.includeChildren || c.pageId !== c.rootPageId);
    if (!c || !grouped) {
      out.push({ kind: "one", source: s });
      continue;
    }
    let g = groups.get(c.rootPageId);
    if (!g) {
      g = { key: c.rootPageId, title: c.rootTitle ?? "", kind: c.rootKind === "folder" ? "folder" : "page", href: null, members: [] };
      groups.set(c.rootPageId, g);
      out.push({ kind: "group", group: g });
    }
    g.members.push(s);
  }
  for (const g of groups.values()) {
    const root = g.members.find((m) => m.meta.confluence?.pageId === g.key);
    const any = g.members.find((m) => m.meta.confluence?.webUrl)?.meta.confluence?.webUrl;
    g.title ||= root ? sourceTitle(root) : g.kind === "folder" ? "Confluence folder" : "Confluence page";
    g.href = g.kind === "page" ? (root?.meta.confluence?.webUrl ?? root?.uri ?? null) : any ? any.replace(/\/pages\/\d+.*$/, `/folder/${g.key}`) : null;
    // The page that was added first, then its child pages by title.
    g.members.sort((a, b) => Number(b.meta.confluence?.pageId === g.key) - Number(a.meta.confluence?.pageId === g.key) || sourceTitle(a).localeCompare(sourceTitle(b)));
  }
  return out;
}

/** One group of Confluence pages: a summary line that opens to the pages. Open by default when a page needs attention. */
function SourceGroupView({ group, render }: { group: SourceGroup; render: (s: SourceRow) => React.ReactNode }) {
  const n = (st: string) => group.members.filter((m) => m.status === st).length;
  const attention = n("failed") + n("needs-transcript");
  const working = n("queued") + n("ingesting");
  const notes = [...new Set(group.members.map((m) => m.meta.note).filter(Boolean))];
  const state = [
    n("ready") === group.members.length ? "all read" : n("ready") ? `${n("ready")} read` : null,
    working ? `${working} reading` : null,
    n("failed") ? `${n("failed")} failed` : null,
    n("needs-transcript") ? `${n("needs-transcript")} need a transcript` : null,
  ].filter(Boolean);
  return (
    <details className="source-group" open={attention > 0 || undefined}>
      <summary className="source-group-head">
        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="source-name">{group.title}</span>
          <span className="small muted">
            Confluence {group.kind === "folder" ? "folder" : "page with child pages"} · {plural(group.members.length, "page")} · {state.join(", ")}
          </span>
        </span>
        <span className={`pill status-${attention ? "failed" : working ? "ingesting" : "ready"}`}>{attention ? "Needs attention" : working ? "Reading" : "Ingested"}</span>
      </summary>
      <div className="source-group-body">
        {group.href && <a className="small" href={group.href} target="_blank" rel="noreferrer">Open {group.kind === "folder" ? "folder" : "page"} in Confluence</a>}
        {notes.map((note) => <span key={note} className="small source-note">Note for the agent: {note}</span>)}
        {group.members.map((m) => render(m))}
      </div>
    </details>
  );
}

/** The last Confluence add or update check: what it found, or why it failed. */
function ConfluenceStatus({ run }: { run: AgentRun }) {
  const s = (run.summary ?? {}) as { added?: number; changed?: number; unchanged?: number; failed?: number; error?: string; problems?: string[] };
  if (run.status === "queued" || run.status === "running") return null;
  const when = timeAgo(run.finishedAt ?? run.createdAt);
  if (run.status === "failed") return <span className="small" style={{ color: "var(--crit)" }}>{run.title} failed {when}: {s.error ?? "unknown error"}</span>;
  const parts = [
    s.added ? `${plural(s.added, "new page")}` : null,
    s.changed ? `${plural(s.changed, "page")} changed` : null,
    s.unchanged ? `${s.unchanged} unchanged` : null,
    s.failed ? `${s.failed} couldn't be read` : null,
  ].filter(Boolean);
  return (
    <span className="small muted">
      Confluence checked {when}: {parts.length ? parts.join(", ") : "no pages found"}.
      {s.problems?.map((p, i) => <span key={i} style={{ display: "block", color: "var(--high)" }}>{p}</span>)}
    </span>
  );
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Which sources a test plan reads, in words. */
function sourcesLabel(t: TrackRow, srcs: SourceRow[]): string {
  if (!t.sourceIds) return "All sources";
  const names = t.sourceIds.map((sid) => srcs.find((x) => x.id === sid)).filter(Boolean).map((x) => sourceTitle(x!));
  return names.length ? names.join(", ") : "Its sources were removed";
}

export default async function TestAssets({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; plan?: string }> }) {
  const { id } = await params;
  const { tab: tabParam, plan: planParam } = await searchParams;
  if (!UUID.test(id)) notFound();
  const row = await projectWithClient(id);
  if (!row) notFound();
  const { project, client } = row;
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "plan";

  const [srcs, tracks, runsList, latest, removed] = await Promise.all([projectSources(id), projectTracks(id), agentRuns(id, 20), latestSiteCheck(id), removedSources(id)]);
  const track = planParam && UUID.test(planParam) ? tracks.find((t) => t.id === planParam) : undefined;
  if (planParam && !track) notFound();
  // Plan runs queued before plans had names belong to the project's first plan.
  const runTrack = (r: AgentRun) => r.trackId ?? tracks[0]?.id ?? null;
  const [reqs, tree, questions] = track ? await Promise.all([liveRequirements(id, track.id), currentPlan(track.id), projectQuestions(id, track.id)]) : [[], null, []];
  // The list of test plans: each one's current version and counts.
  const summaries = track
    ? []
    : await Promise.all(
        tracks.map(async (t) => {
          const [tr, rq] = await Promise.all([currentPlan(t.id), liveRequirements(id, t.id)]);
          return { track: t, tree: tr, reqs: rq.filter((r) => r.reviewState !== "rejected").length };
        }),
      );
  // Test cases in plan order (story by story), not key order, so the Story column reads in runs.
  const cases = tree?.scenarios.flatMap((s) => s.cases.map((c) => ({ ...c, scenario: s }))) ?? [];
  const storyById = new Map((tree?.stories ?? []).map((st) => [st.id, st]));
  const openQuestions = questions.filter((q) => q.status === "open");
  const busy = runsList.some((r) => r.status === "queued" || r.status === "running");
  // The plan is out of date when a source it was drafted from is gone, or a ready source with requirements isn't in it.
  const readyWithReqs = new Set(reqs.flatMap((r) => (r.sourceId ? [r.sourceId] : [])));
  const planSources = new Set(tree?.plan.sourceIds ?? []);
  const staleReasons = tree
    ? [
        ...[...planSources].filter((sid) => !srcs.some((x) => x.id === sid && x.status === "ready")).map(() => "removed"),
        ...[...readyWithReqs].filter((sid) => !planSources.has(sid)).map(() => "added"),
      ]
    : [];
  const stale = !busy && staleReasons.length > 0;
  const hasConfluence = srcs.some((s) => s.type === "confluence");
  const lastConfluence = runsList.find((r) => r.confluence);
  const planRuns = runsList.filter((r) => r.kind === "plan" && (!track || runTrack(r) === track.id));
  const lastPlanRun = planRuns[0];
  const readySources = srcs.filter((s) => s.status === "ready").map((s) => ({ id: s.id, name: sourceTitle(s), type: SOURCE_TYPE_LABEL[s.type] ?? s.type, confluence: s.type === "confluence" }));
  const assetsHref = (t: TrackRow, tabId: Tab = "plan") => `/projects/${id}/assets?plan=${t.id}${tabId === "plan" ? "" : `&tab=${tabId}`}`;
  const inFlight = runsList.filter((r) => r.status === "queued" || r.status === "running");
  const spent = runsList.reduce((n, r) => n + r.costUsd, 0);
  const liveReqs = reqs.filter((r) => r.reviewState !== "rejected");
  /** IDs as shown in this plan: TP1-REQ-01. */
  const K = (key: string | null | undefined) => (key ? (track ? planKey(track.number, key) : key) : "");
  const KL = (keys: string[]) => keys.map(K).join(", ");
  /** Opens an item in the review inbox, filtered to this test plan. */
  const reviewHref = (kind: "req" | "story" | "scenario" | "tc", itemId: string) => `/projects/${id}/review?${track ? `plan=${track.id}&` : ""}item=${kind}:${itemId}`;
  /** The same prefix for IDs the agent wrote inside its sentences ("REQ-17 (Focal) and REQ-25 can't both hold"). */
  const KT = (text: string) => (track ? text.replace(/\b(?<!-)((?:REQ|US|SC|TC)-\d+)\b/g, (m) => planKey(track.number, m)) : text);
  const critical = new Set(tree?.plan.body?.critical?.map((c) => c.key) ?? []);
  const criticalWhy = new Map(tree?.plan.body?.critical?.map((c) => [c.key, c.why]) ?? []);
  const kindsFor = (key: string) => {
    const n = { happy: 0, negative: 0, edge: 0 } as Record<string, number>;
    for (const s of tree?.scenarios ?? []) if (s.requirementIds.includes(key)) n[s.kind] = (n[s.kind] ?? 0) + 1;
    return n;
  };
  const reqTitle = new Map(liveReqs.map((r) => [r.key, r.title]));
  const storyKinds = (storyId: string) => {
    const n = { happy: 0, negative: 0, edge: 0 } as Record<string, number>;
    for (const x of tree?.scenarios ?? []) if (x.storyId === storyId) n[x.kind] = (n[x.kind] ?? 0) + 1;
    return n;
  };
  const withPositive = liveReqs.filter((r) => kindsFor(r.key).happy).length;
  const criticalLive = liveReqs.filter((r) => critical.has(r.key));
  const withNegative = criticalLive.filter((r) => kindsFor(r.key).negative).length;

  // Passage labels for the coverage and questions tabs.
  const chunkIds = tab === "coverage" ? liveReqs.flatMap((r) => r.sourceChunkIds.slice(0, 1)) : tab === "questions" ? questions.flatMap((q) => q.sourceChunkIds.slice(0, 2)) : [];
  const where = new Map((await passages(chunkIds)).map((p) => [p.id, p]));
  const citeLabel = (ids: string[]) =>
    ids
      .map((i) => where.get(i))
      .filter(Boolean)
      .map((p) => [p!.sourceName, p!.sectionPath].filter(Boolean).join(" · "))
      .join(" and ");

  const tabs: { id: Tab; label: string }[] = [
    { id: "plan", label: "Plan" },
    { id: "requirements", label: `Requirements · ${liveReqs.length}` },
    { id: "stories", label: `User stories · ${tree?.stories.length ?? 0}` },
    { id: "scenarios", label: `Scenarios · ${tree?.scenarios.length ?? 0}` },
    { id: "cases", label: `Test cases · ${cases.length}` },
    { id: "coverage", label: "Coverage" },
    { id: "questions", label: `Questions · ${openQuestions.length}` },
  ];
  const body = tree?.plan.body;
  /** Reading a source again starts the agent, so the button asks first and says which plans it touches. */
  const readAgain = (s: SourceRow, label: string, className: string, opts: { disabled?: boolean; title?: string } = {}) => {
    const using = tracks.filter((t) => t.sourceIds === null || t.sourceIds.includes(s.id));
    const names = using.map((t) => `${planCode(t.number)} ${t.name}`).join(", ");
    const estimate = using.length * 0.55;
    const replaced = s.status === "ready";
    return (
      <ConfirmAction
        action={retrySource}
        fields={{ sourceId: s.id }}
        label={label}
        className={className}
        disabled={opts.disabled}
        title={opts.title}
        heading={s.type === "loom" && s.status === "needs-transcript" ? "Try Loom again?" : replaced ? "Read this source again?" : "Try reading this source again?"}
        subtitle={sourceTitle(s)}
        intro={s.type === "loom" && s.status === "needs-transcript" ? "The agent checks whether Loom has a transcript for this video now, and reads it if so." : "The agent reads this source again with the project's current instructions."}
        points={[
          using.length ? (using.length === 1 ? `It's read for ${names}, the one test plan that uses it.` : `It's read for the ${using.length} test plans that use it: ${names}.`) : "No test plan uses this source yet, so nothing is drafted.",
          replaced && using.length ? `Its requirements and client questions in ${using.length === 1 ? "that plan" : "those plans"} are replaced, so approvals on them are lost.` : null,
          using.length ? `${using.length === 1 ? "That plan is" : "Those plans are"} then drafted again. Approved user stories and test cases are kept.` : null,
          using.length ? `About $0.15 per plan to read and $0.40 per plan to draft: around $${estimate.toFixed(2)} in all, more for a long source.` : null,
        ]}
        confirmLabel={replaced ? "Read again" : "Try again"}
      />
    );
  };
  const sourceRow = (s: SourceRow, inGroup = false) => {
    const canRemove = s.status === "ready" || s.status === "failed" || s.status === "needs-transcript";
    const canReread = s.status === "ready" && !!(s.fileUri || s.uri);
    const openHref = s.type === "loom" ? s.uri : s.type === "confluence" ? (s.meta.confluence?.webUrl ?? s.uri) : null;
    return (
      <div key={s.id} className={`source-row${inGroup ? " source-row-sub" : ""}`}>
        <div className="row">
          {s.status === "ready" ? <Link className="source-name" href={`/sources/${s.id}`}>{sourceTitle(s)}</Link> : <span className="source-name">{sourceTitle(s)}</span>}
          <span className={`pill status-${s.status}`}>{SOURCE_STATUS_LABEL[s.status] ?? s.status}</span>
        </div>
        {sourceDetail(s, inGroup) && <span className="small muted">{sourceDetail(s, inGroup)}</span>}
        {s.meta.note && !inGroup && <span className="small source-note">Note for the agent: {s.meta.note}</span>}
        {s.error && <span className="small" style={{ color: s.status === "failed" ? "var(--crit)" : "var(--high)" }}>{s.error}</span>}
        {s.status === "needs-transcript" && (
          <>
            {s.type === "loom" && s.uri && (
              readAgain(s, "Try Loom again", "btn btn-outline btn-sm", { disabled: busy })
            )}
            <AttachTranscript sourceId={s.id} />
          </>
        )}
        {s.status === "failed" && (
          readAgain(s, "Try again", "btn btn-outline btn-sm")
        )}
        {(openHref || canRemove || canReread) && (
          <div className="source-actions small">
            {openHref && <a href={openHref} target="_blank" rel="noreferrer">Open in {s.type === "loom" ? "Loom" : "Confluence"}</a>}
            {canReread && readAgain(s, "Read again", "link-btn small", { disabled: busy })}
            {canRemove && (
              <details className="remove-source">
                <summary className="small">Remove</summary>
                <form action={removeSource} className="stack" style={{ gap: 6, marginTop: 6 }}>
                  <input type="hidden" name="sourceId" value={s.id} />
                  <span className="small muted">Its requirements stop feeding the plans and its open client questions are withdrawn. Approved test cases stay. You can restore it later.</span>
                  <button type="submit" className="btn btn-danger btn-sm" style={{ alignSelf: "flex-start" }}>Remove {sourceTitle(s)}</button>
                </form>
              </details>
            )}
          </div>
        )}
      </div>
    );
  };
  const sourceItems = groupSources(srcs);

  const working = inFlight.length > 0 && (
    <section className="panel working-panel" aria-label="Agent progress">
      {[...inFlight].reverse().map((r) => (
        <RunProgress key={r.id} title={r.title} status={r.status} progress={progressOf(r)} startedAt={r.startedAt?.toISOString() ?? null} />
      ))}
    </section>
  );


  return (
    <Shell active="assets" project={{ id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <AutoRefresh active={busy} />
      <div className="page-head">
        <div>
          <span className="crumbs">
            <Link href={`/projects/${id}`}>{client.name}</Link> / {track ? <><Link href={`/projects/${id}/assets`}>Test assets</Link> / {track.name}</> : "Test assets"}
          </span>
          <div className="title-row">
            <h1>{track ? <><span className="muted">{planCode(track.number)} · </span>{track.name}</> : project.name}</h1>
            {tree && <span className={`pill status-${tree.plan.status}`}>v{tree.plan.version} · {REVIEW_LABEL[tree.plan.status] ?? tree.plan.status}</span>}
          </div>
          {track?.focus && <span className="muted small">Covers: {track.focus}</span>}
        </div>
        <div className="row">
          <Link className="btn" href={`/projects/${id}/review${track ? `?plan=${track.id}` : ""}`}>Review and approve</Link>
        </div>
      </div>

      <div className="assets-layout">
        <aside className="assets-side">
          <section className="panel" aria-label="Instructions for the agent">
            <AgentInstructions projectId={id} value={project.agentInstructions ?? ""} hasPlan={tracks.length > 0} />
          </section>

          <section className="panel" aria-labelledby="sources-h">
            <h2 id="sources-h" style={{ fontSize: 15 }}>Sources</h2>
            {!srcs.length && <p className="muted small" style={{ margin: 0 }}>Nothing yet. Add the client&apos;s brief, requirements document, a Confluence page or a Loom walkthrough.</p>}
            {sourceItems.map((item) =>
              item.kind === "one" ? sourceRow(item.source) : <SourceGroupView key={item.group.key} group={item.group} render={(x) => sourceRow(x, true)} />,
            )}
            {(hasConfluence || lastConfluence) && (
              <div className="stack" style={{ gap: 6, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                {lastConfluence && <ConfluenceStatus run={lastConfluence} />}
                {hasConfluence && (
                  <ConfirmAction
                    action={checkConfluence}
                    fields={{ projectId: id }}
                    label="Check Confluence for updates"
                    className="btn btn-outline btn-sm"
                    disabled={busy}
                    heading="Check Confluence for updates?"
                    subtitle={`${plural(srcs.filter((x) => x.type === "confluence" && x.status !== "removed").length, "Confluence page")} in this project`}
                    intro="The agent looks at every Confluence page and folder in this project for changes."
                    points={[
                      "Pages that haven't changed are skipped, at no cost.",
                      "A changed page gets a new version, and new pages in a folder are added. Each is read for every test plan that uses it, about $0.15 per page per plan.",
                      "Plans whose pages changed are then drafted again, about $0.40 each. Approved user stories and test cases are kept.",
                      "Requirements from a changed page are replaced, so approvals on them are lost.",
                    ]}
                    confirmLabel="Check for updates"
                  />
                )}
              </div>
            )}
            {removed.length > 0 && (
              <details className="small" style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Removed sources · {removed.length}</summary>
                <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                  {removed.map((s) => (
                    <div key={s.id} className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", alignItems: "center", gap: 8 }}>
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{sourceTitle(s)}</span>
                        <span className="muted">{SOURCE_TYPE_LABEL[s.type] ?? s.type}{s.meta.removedBy ? ` · removed by ${s.meta.removedBy}` : ""}</span>
                      </span>
                      <form action={restoreSource}>
                        <input type="hidden" name="sourceId" value={s.id} />
                        <button type="submit" className="btn btn-outline btn-sm">Restore</button>
                      </form>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <AddSource projectId={id} />
          </section>

          <section className="agent-card" aria-labelledby="gen-h">
            <div className="row" style={{ gap: 8 }}><span className="tag">AGENT</span><h2 id="gen-h" style={{ fontSize: 14 }}>Generation run</h2></div>
            {inFlight.length > 0 && <span className="small muted">{plural(inFlight.length, "job")} running; progress is shown above the {track ? "plan" : "test plans"}.</span>}
            {track && lastPlanRun && lastPlanRun.status === "done" && (
              <span className="facts-line">
                {[
                  plural(liveReqs.length, "requirement"),
                  plural(tree?.scenarios.length ?? 0, "scenario"),
                  plural(cases.length, "test case"),
                  plural(openQuestions.length, "question") + " for the client",
                  `${usd(spent)} so far`,
                  duration(lastPlanRun.startedAt, lastPlanRun.finishedAt) ? `last plan took ${duration(lastPlanRun.startedAt, lastPlanRun.finishedAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {lastPlanRun?.status === "failed" && <span className="small" style={{ color: "var(--crit)" }}>The last plan run failed: {String(lastPlanRun.summary?.error ?? "unknown error")}</span>}
            {!runsList.length && <span className="facts-line">Add a source and the agent reads it, extracts requirements and drafts a plan for you to review.</span>}
            {track && stale && (
              <p className="banner" role="status" style={{ margin: 0 }}>
                {reqs.length
                  ? <>The sources have changed since this plan was drafted{staleReasons.includes("removed") ? " (a source was removed or replaced)" : ""}{staleReasons.includes("added") ? " (a source isn't in it yet)" : ""}. Draft the plan again to bring it up to date; approved stories and test cases are kept.</>
                  : <>None of the sources this plan was drafted from are in the project any more. Add or restore a source to draft a new plan.</>}
              </p>
            )}
            {track && reqs.length > 0 && (
              <DraftAgain
                projectId={id}
                trackId={track.id}
                label={`Draft ${track.name} again`}
                title={`${planCode(track.number)} · ${track.name}`}
                version={tree?.plan.version ?? null}
                requirements={liveReqs.length}
                sourceIds={track.sourceIds}
                sources={readySources}
                lastCost={planRuns.find((r) => r.title.startsWith("Draft test plan") && r.status === "done" && r.costUsd > 0)?.costUsd ?? null}
                disabled={busy}
                className="btn btn-outline btn-sm"
              />
            )}
            {!track && <span className="facts-line">{plural(tracks.length, "test plan")} · {usd(spent)} spent on the agent so far</span>}
            {runsList.length > 0 && (
              <details className="small">
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Agent runs</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  {runsList.map((r) => (
                    <span key={r.id} className="muted">
                      {r.title} · {timeAgo(r.createdAt)} · {RunStatusText(r.status)}{r.costUsd ? ` · ${usd(r.costUsd)} · ${(r.inputTokens / 1000).toFixed(0)}k in / ${(r.outputTokens / 1000).toFixed(0)}k out` : ""}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </section>
        </aside>

        {!track ? (
        <section className="assets-main" aria-labelledby="plans-h">
          {working}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 id="plans-h" style={{ fontSize: 16 }}>Test plans</h2>
            <span className="small muted">Each plan has its own topic, requirements, review and coverage. Sources are shared.</span>
          </div>
          {!summaries.length && (
            <div className="empty">{srcs.length ? (busy ? "The agent is reading the sources. The first test plan appears here when it's ready." : "No test plans yet. Start one below.") : "No test plans yet. Add a source and the agent drafts the first one, or start one below once a source is ready."}</div>
          )}
          {summaries.map(({ track: t, tree: tr, reqs: n }) => {
            const active = inFlight.find((r) => r.trackId === t.id);
            const running = !!active;
            const last = runsList.find((r) => r.kind === "plan" && runTrack(r) === t.id);
            const caseCount = tr?.scenarios.reduce((k, x) => k + x.cases.length, 0) ?? 0;
            return (
              <article key={t.id} className="panel plan-card" aria-labelledby={`plan-${t.id}`}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <Link id={`plan-${t.id}`} className="list-title" href={assetsHref(t)} style={{ textDecoration: "none", fontSize: 16 }}><span className="muted">{planCode(t.number)} · </span>{t.name}</Link>
                    {tr && <span className="small muted">{tr.plan.name}</span>}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    {running && <span className="row small" style={{ gap: 6 }}><RunStatus status="running" /> Working</span>}
                    {tr ? <span className={`pill status-${tr.plan.status}`}>v{tr.plan.version} · {REVIEW_LABEL[tr.plan.status] ?? tr.plan.status}</span> : !running && <span className="pill">Not drafted</span>}
                  </span>
                </div>
                <span className="small" style={{ color: "var(--ink-2)" }}>{t.focus ? <>Covers: {t.focus}</> : "Covers everything in its sources"}</span>
                <span className="facts-line">
                  {[plural(n, "requirement"), plural(tr?.stories.length ?? 0, "user story", "user stories"), plural(tr?.scenarios.length ?? 0, "scenario"), plural(caseCount, "test case")].join(" · ")}
                </span>
                <span className="small muted">Sources: {sourcesLabel(t, srcs)}</span>
                {!running && last?.status === "failed" && <span className="small" style={{ color: "var(--crit)" }}>The last run failed: {String(last.summary?.error ?? "unknown error")}</span>}
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <Link className="btn btn-outline btn-sm" href={assetsHref(t)}>Open</Link>
                  {n > 0 && (
                    <DraftAgain
                      projectId={id}
                      trackId={t.id}
                      label="Draft again"
                      title={`${planCode(t.number)} · ${t.name}`}
                      version={tr?.plan.version ?? null}
                      requirements={n}
                      sourceIds={t.sourceIds}
                      sources={readySources}
                      lastCost={runsList.find((r) => r.kind === "plan" && r.title.startsWith("Draft test plan") && runTrack(r) === t.id && r.status === "done" && r.costUsd > 0)?.costUsd ?? null}
                      disabled={busy}
                      className="link-btn small"
                    />
                  )}
                </div>
                <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
                  <EditPlan trackId={t.id} name={t.name} focus={t.focus ?? ""} sourceIds={t.sourceIds} sources={readySources} busy={inFlight.length > 0} />
                  <DeletePlan trackId={t.id} name={t.name} code={planCode(t.number)} only={tracks.length === 1} />
                </div>
              </article>
            );
          })}
          {(srcs.length > 0 || tracks.length > 0) && <NewPlanForm projectId={id} sources={readySources} />}
        </section>
        ) : (
        <section className="assets-main">
          {working}
          <Link className="small" href={`/projects/${id}/assets`}>← All test plans</Link>
          <nav className="tabs" aria-label="Asset view">
            {tabs.map((t) => (
              <Link key={t.id} className="tab" href={assetsHref(track, t.id)} aria-current={t.id === tab ? "page" : undefined}>{t.label}</Link>
            ))}
          </nav>

          {tab === "plan" && (
            !tree ? (
              <div className="empty">{busy ? "The agent is working on it. The plan appears here when it's ready." : lastPlanRun?.status === "failed" ? `The last run failed: ${String(lastPlanRun.summary?.error ?? "unknown error")}` : "Not drafted yet."}</div>
            ) : (
              <div className="panel" style={{ gap: 18 }}>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <h2 style={{ fontSize: 16 }}>{tree.plan.name}</h2>
                    <span className={`pill status-${tree.plan.status}`}>{REVIEW_LABEL[tree.plan.status] ?? tree.plan.status}</span>
                    {tree.plan.status === "approved" && tree.plan.reviewedAt && (
                      <span className="small muted">
                        {tree.plan.reviewedBy ? `by ${tree.plan.reviewedBy} ` : ""}on {new Date(tree.plan.reviewedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                      </span>
                    )}
                  </div>
                  {body?.summary && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{KT(body.summary)}</p>}
                </div>
                <div className="kv">
                  <div><h3>In scope</h3><ul className="ul">{body?.scope.map((s, i) => <li key={i}>{KT(s)}</li>)}</ul></div>
                  <div><h3>Out of scope</h3>{body?.outOfScope.length ? <ul className="ul">{body.outOfScope.map((s, i) => <li key={i}>{KT(s)}</li>)}</ul> : <span className="muted">Nothing stated</span>}</div>
                </div>
                {!!body?.gaps?.length && (
                  <p className="banner" role="note" style={{ margin: 0 }}>
                    Still missing after the agent&apos;s second pass: {body.gaps.map((g) => `${g.missing} scenario for ${K(g.key)}`).join(", ")}. The sources may not say enough; add them while reviewing, or ask the client.
                  </p>
                )}
                <h3>Risk-ranked areas</h3>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table style={{ minWidth: 560 }}>
                    <thead><tr><th>Area</th><th>Risk</th><th>Why</th><th>Priority</th></tr></thead>
                    <tbody>
                      {body?.risks.map((r, i) => (
                        <tr key={i}><td style={{ fontWeight: 600 }}>{r.area}</td><td>{r.risk[0]!.toUpperCase() + r.risk.slice(1)}</td><td style={{ color: "var(--ink-2)" }}>{KT(r.why)}</td><td><span className="pill prio">{r.priority}</span></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!!body?.critical?.length && (
                  <>
                    <h3>Critical requirements</h3>
                    <p className="small muted" style={{ margin: 0 }}>Each gets a negative scenario as well as a positive one.</p>
                    <ul className="ul">{body.critical.map((c) => <li key={c.key}><strong>{K(c.key)}</strong> {reqTitle.get(c.key) ?? ""}: {KT(c.why)}</li>)}</ul>
                  </>
                )}
              </div>
            )
          )}

          {tab === "requirements" && (
            liveReqs.length ? (
              <div className="table-wrap">
                <table style={{ minWidth: 640 }}>
                  <thead><tr><th>Key</th><th>Requirement</th><th>Area</th><th>State</th></tr></thead>
                  <tbody>
                    {reqs.map((r) => (
                      <tr key={r.id}>
                        <td className="muted nowrap">{K(r.key)}</td>
                        <td><Link className="cell-link" href={reviewHref("req", r.id)}>{r.title}</Link><div className="sub">{r.text}</div></td>
                        <td>{r.area}</td>
                        <td><span className={`pill status-${r.reviewState}`}>{REVIEW_LABEL[r.reviewState]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty">No requirements yet.</div>
          )}

          {tab === "stories" && (
            tree?.stories.length ? (
              <div className="stack" style={{ gap: 12 }}>
                {tree.stories.map((st) => {
                  const scen = tree.scenarios.filter((x) => x.storyId === st.id);
                  const k = storyKinds(st.id);
                  return (
                    <article key={st.id} className="panel story-card" aria-labelledby={`st-${st.id}`}>
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                          <span className="small muted">{K(st.key)} · covers {KL(st.requirementIds)}</span>
                          <Link id={`st-${st.id}`} className="list-title" href={reviewHref("story", st.id)} style={{ textDecoration: "none", fontSize: 16 }}>{st.title}</Link>
                        </span>
                        <span className="row" style={{ gap: 6 }}>
                          <span className="pill prio">{st.priority}</span>
                          {st.critical && <span className="pill gap-pill">Critical</span>}
                          <span className={`pill status-${st.reviewState}`}>{REVIEW_LABEL[st.reviewState]}</span>
                        </span>
                      </div>
                      <p className="story-text">
                        <strong>As a</strong> {st.actor}, <strong>I want to</strong> {st.want}
                        {st.soThat ? <>, <strong>so that</strong> {st.soThat}</> : null}.
                      </p>
                      {st.critical && st.criticalWhy && <span className="small" style={{ color: "var(--ink-2)" }}>Why it&apos;s critical: {KT(st.criticalWhy)}</span>}
                      {!!st.acceptanceCriteria.length && (
                        <div className="stack" style={{ gap: 4 }}>
                          <span className="kv-label">Acceptance criteria</span>
                          <ul className="ul">{st.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                        </div>
                      )}
                      <div className="stack" style={{ gap: 6 }}>
                        <span className="kv-label">Scenarios · {[k.happy && `${k.happy} positive`, k.negative && `${k.negative} negative`, k.edge && `${k.edge} edge`].filter(Boolean).join(", ") || "none"}</span>
                        {scen.map((x) => (
                          <span key={x.id} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                            <span className={`pill kind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                            <span><Link className="cell-link" href={reviewHref("scenario", x.id)}>{x.key && <span className="muted">{K(x.key)} · </span>}{x.title}</Link> · {x.priority} · {plural(x.cases.length, "case")}</span>
                          </span>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : <div className="empty">{tree ? "This plan was drafted before user stories. Press Draft the plan again to add them." : "No user stories yet."}</div>
          )}

          {tab === "scenarios" && (
            tree?.scenarios.length ? (
              <div className="stack" style={{ gap: 12 }}>
                {[...tree.stories.map((st) => ({ story: st as (typeof tree.stories)[number] | null, list: tree.scenarios.filter((x) => x.storyId === st.id) })), { story: null, list: tree.scenarios.filter((x) => !x.storyId || !tree.stories.some((st) => st.id === x.storyId)) }]
                  .filter((g) => g.list.length)
                  .map((g) => (
                    <section key={g.story?.id ?? "none"} className="panel" style={{ padding: 0, gap: 0 }} aria-label={g.story ? `${g.story.key} ${g.story.title}` : "Scenarios"}>
                      {tree.stories.length > 0 && (
                        <h3 className="group-head">{g.story ? <>{K(g.story.key)} · {g.story.title}</> : "Not linked to a story"}</h3>
                      )}
                      {g.list.map((s) => (
                        <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
                          <span className="stack" style={{ gap: 2, flex: "1 1 320px", minWidth: 0 }}>
                            <Link className="list-title" href={reviewHref("scenario", s.id)} style={{ fontSize: 14, fontWeight: 600, textDecoration: "none" }}>{s.key && <span className="muted" style={{ fontWeight: 500 }}>{K(s.key)} · </span>}{s.title}</Link>
                            {s.situation && (
                              <span className="small" style={{ color: "var(--ink-2)" }}>
                                {s.actor && <strong>{s.actor} </strong>}
                                {s.situation}
                                {s.outcome && <> → {s.outcome}</>}
                              </span>
                            )}
                            <span className="small muted">{s.requirementIds.map((k) => (critical.has(k) ? `${K(k)} (critical)` : K(k))).join(", ")} · {plural(s.cases.length, "case")}{s.cases.length ? `: ${KL(s.cases.map((x) => x.key))}` : ""}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}><span className="pill prio">{s.priority}</span><span className={`pill kind-${s.kind}`}>{KIND_LABEL[s.kind] ?? s.kind}</span></span>
                        </div>
                      ))}
                    </section>
                  ))}
              </div>
            ) : <div className="empty">No scenarios yet.</div>
          )}

          {tab === "cases" && (
            cases.length ? (
              <div className="table-wrap">
                <table style={{ minWidth: 880 }}>
                  <thead><tr><th>ID</th><th>Story</th><th>Scenario</th><th>Test case</th><th className="num">Steps</th><th>Type</th><th>State</th></tr></thead>
                  <tbody>
                    {cases.map((c) => {
                      const story = c.scenario.storyId ? storyById.get(c.scenario.storyId) : undefined;
                      return (
                      <tr key={c.id}>
                        <td className="muted nowrap">{K(c.key)}</td>
                        <td className="nowrap">{story ? <Link className="cell-link" href={reviewHref("story", story.id)} title={story.title}>{K(story.key)}</Link> : <span className="muted">–</span>}</td>
                        <td className="nowrap" title={c.scenario.title}>{c.scenario.key ? K(c.scenario.key) : <span className="muted">–</span>}</td>
                        <td>
                          <Link className="cell-link" href={reviewHref("tc", c.id)}>{c.title}</Link>
                          <div className="case-scenario">
                            <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                              <span className={`pill kind-${c.scenario.kind}`}>{KIND_LABEL[c.scenario.kind] ?? c.scenario.kind}</span>
                              <span className="pill prio">{c.scenario.priority}</span>
                              <span className="case-scenario-title">{c.scenario.key ? `${K(c.scenario.key)} · ` : "Scenario: "}{c.scenario.title}</span>
                            </span>
                            {c.scenario.situation && (
                              <span className="sub">
                                {c.scenario.actor && <strong>{c.scenario.actor}: </strong>}
                                {c.scenario.situation}
                                {c.scenario.outcome && <> → {c.scenario.outcome}</>}
                              </span>
                            )}
                            {c.scenario.cases.length > 1 && <span className="sub">One of {c.scenario.cases.length} cases for this scenario: {KL(c.scenario.cases.map((x) => x.key))}</span>}
                          </div>
                        </td>
                        <td className="num">{c.steps.length}</td>
                        <td>{c.automationCandidate ? "Automation candidate" : "Manual"}</td>
                        <td><span className={`pill status-${c.reviewState}`}>{REVIEW_LABEL[c.reviewState]}{c.edited ? " · edited" : ""}</span></td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty">No test cases yet.</div>
          )}

          {tab === "coverage" && (
            liveReqs.length ? (
              <div className="panel">
                {!!tree?.stories.length && (
                  <>
                    <h3 style={{ margin: 0 }}>By user story</h3>
                    {tree.stories.map((st) => {
                      const k = storyKinds(st.id);
                      return (
                        <div key={st.id} className="list-row">
                          <span>
                            <Link className="list-title" href={reviewHref("story", st.id)} style={{ textDecoration: "none" }}>{K(st.key)} {st.title}</Link>
                            <span className="list-sub">{st.critical ? "Critical · " : ""}covers {KL(st.requirementIds)}</span>
                          </span>
                          <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {k.happy ? <span className="pill kind-happy">{k.happy} positive</span> : <span className="pill gap-pill">No positive</span>}
                            {k.negative ? <span className="pill kind-negative">{k.negative} negative</span> : st.critical ? <span className="pill gap-pill">No negative</span> : null}
                            {k.edge ? <span className="pill kind-edge">{k.edge} edge</span> : null}
                          </span>
                        </div>
                      );
                    })}
                    <h3 style={{ margin: "12px 0 0" }}>By requirement</h3>
                  </>
                )}
                <span className="muted">
                  {withPositive} of {plural(liveReqs.length, "requirement")} have a positive scenario
                  {criticalLive.length ? `; ${withNegative} of ${criticalLive.length} critical ones have a negative scenario` : ""}. Each links back to its source passage.
                </span>
                {liveReqs.map((r) => {
                  const k = kindsFor(r.key);
                  const isCritical = critical.has(r.key);
                  const first = where.get(r.sourceChunkIds[0] ?? "");
                  return (
                    <div key={r.id} className="list-row">
                      <span>
                        <Link className="list-title" href={reviewHref("req", r.id)} style={{ textDecoration: "none" }}>{K(r.key)} {r.title}</Link>
                        {isCritical && <span className="list-sub">Critical: {KT(criticalWhy.get(r.key) ?? "")}</span>}
                        {first && <Link className="list-sub" href={first.href}>{citeLabel([first.id])}</Link>}
                      </span>
                      <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {k.happy ? <span className="pill kind-happy">{k.happy} positive</span> : <span className="pill gap-pill">No positive</span>}
                        {k.negative ? <span className="pill kind-negative">{k.negative} negative</span> : isCritical ? <span className="pill gap-pill">No negative</span> : null}
                        {k.edge ? <span className="pill kind-edge">{k.edge} edge</span> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : <div className="empty">No requirements yet.</div>
          )}

          {tab === "questions" && (
            questions.length ? (
              <div className="panel">
                <span className="muted">The agent found these gaps in the sources instead of guessing. Send them to the client, then record the answers here.</span>
                {questions.map((q) => (
                  <div key={q.id} className="stack" style={{ gap: 6, padding: "12px 0", borderTop: "1px solid var(--rule)" }}>
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{q.question}</span>
                      {q.status !== "open" && <span className="pill">{q.status === "answered" ? "Answered" : "Dismissed"}</span>}
                    </div>
                    <span className="small muted">{[q.why, citeLabel(q.sourceChunkIds.slice(0, 2))].filter(Boolean).join(" · ")}</span>
                    {q.answer && <span className="small">Answer: {q.answer}</span>}
                    {q.status === "open" && (
                      <form action={updateQuestion} className="row" style={{ gap: 8 }}>
                        <input type="hidden" name="id" value={q.id} />
                        <label className="sr-only" htmlFor={`ans-${q.id}`}>Client&apos;s answer</label>
                        <input id={`ans-${q.id}`} name="answer" className="input" placeholder="Client's answer" style={{ flex: "1 1 240px", minHeight: 40 }} />
                        <button type="submit" name="status" value="answered" className="btn btn-outline btn-sm">Save answer</button>
                        <button type="submit" name="status" value="dismissed" className="btn btn-outline btn-sm">Dismiss</button>
                      </form>
                    )}
                  </div>
                ))}
                {openQuestions.length > 0 && (
                  <details>
                    <summary className="btn btn-dark btn-sm" style={{ display: "inline-flex", listStyle: "none" }}>Show as a client email</summary>
                    <pre className="evidence-pre" style={{ marginTop: 10 }}>{`Hi ${client.name} team,\n\nWhile planning testing for ${project.name} we found a few things the documents don't settle. Could you let us know:\n\n${openQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n")}\n\nThanks!`}</pre>
                  </details>
                )}
              </div>
            ) : <div className="empty">No questions for the client.</div>
          )}
        </section>
        )}
      </div>
    </Shell>
  );
}

/** The worker's progress report on a running job, if it has sent one. */
function progressOf(r: AgentRun): Progress | null {
  const p = (r.summary as { progress?: Progress } | null)?.progress;
  return p && typeof p.total === "number" ? p : null;
}

function RunStatusText(status: string) {
  return { queued: "queued", running: "running", done: "done", failed: "failed", "needs-review": "needs input" }[status] ?? status;
}
