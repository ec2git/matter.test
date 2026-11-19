import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { CONFLUENCE_MAX_PAGES, artefactPath, confluencePageUrl, type ConfluenceJob, type IngestJob, type PlanJob, type SourceType, type TrackJob } from "@mattertest/core";
import {
  type Db,
  clientQuestions,
  clients,
  environments,
  planTracks,
  projects,
  requirements,
  runs,
  scenarios,
  sourceChunks,
  sources,
  tasks,
  testCases,
  testPlans,
  userStories,
} from "@mattertest/db";
import {
  AgentError,
  ConfluenceError,
  NOT_SET_UP,
  NO_USAGE,
  NeedsTranscript,
  addUsage,
  draftPlan,
  extractRequirements,
  loadGuidelines,
  readPageTree,
  readSource,
  resolveRoot,
  type ConfluenceConfig,
  type KeptWork,
  type QaGuidelines,
  type Embedder,
  type PlanInputChunk,
  type ProjectContext,
  type StoredChunk,
  type StructuredModel,
  type Usage,
} from "@mattertest/agent";

export type AgentDeps = {
  model: StructuredModel;
  embedder: Embedder | null;
  fetch?: typeof fetch;
  /** Matter Design's QA guidelines; defaults to reading docs/qa-guidelines.md fresh on each job. */
  guidelines?: () => Promise<QaGuidelines | null>;
  /** Confluence connection, or null when it isn't set up. */
  confluence?: ConfluenceConfig | null;
  /** Put a plan job on the queue (the worker passes the BullMQ queue; tests run it inline). */
  queuePlan: (job: PlanJob) => Promise<void>;
  /** Put a test-plan read job on the queue; used when "Draft again" runs after a Confluence check. */
  queueTrack?: (job: TrackJob) => Promise<void>;
  log?: (msg: string) => void;
};

/** Most characters of source text shown to the planner before it falls back to only the cited passages (~150k tokens). */
const PLAN_CONTEXT_CHARS = 600_000;

async function start(db: Db, taskId: string, runId: string) {
  await db.update(runs).set({ status: "running", startedAt: new Date() }).where(eq(runs.id, runId));
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId));
}

/**
 * Where a running job is, for the progress bar on Test assets: steps done out of the total, the step under way
 * and how long it usually takes (the page fills the bar towards the step's end as time passes).
 */
export type RunProgress = { label: string; done: number; total: number; stepWeight: number; stepStartedAt: string; expectSec: number };

async function progress(db: Db, runId: string, p: Omit<RunProgress, "stepStartedAt">) {
  const value = JSON.stringify({ progress: { ...p, stepStartedAt: new Date().toISOString() } });
  await db.update(runs).set({ summary: sql`coalesce(${runs.summary}, '{}'::jsonb) || ${value}::jsonb` }).where(eq(runs.id, runId));
}

/** Rough seconds for Claude to extract one source: longer sources take longer. */
const extractSecs = (passages: number) => Math.min(300, 20 + Math.round(passages * 1.2));

/** How long this project's plan drafts have taken lately, or a typical figure before there are any. */
async function planSecs(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ secs: sql<string | null>`avg(extract(epoch from ${runs.finishedAt} - ${runs.startedAt}))` })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), eq(tasks.kind, "plan"), eq(runs.status, "done"), sql`${runs.finishedAt} > now() - interval '30 days'`, sql`coalesce(${tasks.params}->>'newPlan', 'false') <> 'true'`));
  const secs = Number(row?.secs ?? 0);
  return secs > 30 ? Math.round(secs) : 170;
}

/** A step inside reading one source: its position among the source's steps, and how long it usually takes. */
type StepReport = (s: { label: string; index: number; count: number; expectSec: number }) => Promise<void>;

async function finish(db: Db, taskId: string, runId: string, status: "done" | "failed" | "needs-review", usage: Usage, summary: Record<string, unknown>) {
  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      summary,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd.toFixed(4),
    })
    .where(eq(runs.id, runId));
  await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
}

async function projectContext(db: Db, projectId: string, deps: AgentDeps): Promise<ProjectContext & { guidelinesVersion?: string }> {
  const [row] = await db
    .select({ project: projects.name, client: clients.name, platform: projects.platform, instructions: projects.agentInstructions })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error("Project not found");
  const [env] = await db.select({ baseUrl: environments.baseUrl }).from(environments).where(eq(environments.projectId, projectId)).orderBy(environments.createdAt).limit(1);
  const guide = await (deps.guidelines ?? (() => loadGuidelines()))();
  return { ...row, siteUrl: env?.baseUrl ?? null, guidelines: guide?.text ?? null, guidelinesVersion: guide?.version };
}

/** Next free number for keys like REQ-07 / TC-014 in a column. */
function nextNumber(keys: string[], prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return keys.reduce((n, k) => Math.max(n, Number(k.match(re)?.[1] ?? 0)), 0) + 1;
}
const keyOf = (prefix: string, n: number, width: number) => `${prefix}-${String(n).padStart(width, "0")}`;

type Source = typeof sources.$inferSelect;
type Track = typeof planTracks.$inferSelect;

/** The project's test plans in the order the team made them; a project with none gets a first one. */
async function projectTracks(db: Db, projectId: string): Promise<Track[]> {
  const rows = await db.select().from(planTracks).where(eq(planTracks.projectId, projectId)).orderBy(planTracks.position, planTracks.createdAt);
  if (rows.length) return rows;
  const [first] = await db.insert(planTracks).values({ projectId, number: 1, name: "Test plan" }).returning();
  return [first!];
}

/** Does this test plan read this source? Null means every source in the project. */
const usesSource = (t: Pick<Track, "sourceIds">, sourceId: string) => !t.sourceIds || t.sourceIds.includes(sourceId);

type Extracted = { usage: Usage; requirements: number; questions: number; dropped: unknown; model: string };

/**
 * Extract one source's requirements and client questions for one test plan, with the plan's focus, replacing
 * whatever that plan had from the source before. Requirement numbers continue across the project.
 */
async function extractInto(db: Db, deps: AgentDeps, ctx: ProjectContext, source: Source, track: Track, chunks: StoredChunk[], title?: string): Promise<Extracted> {
  const extracted = await extractRequirements(deps.model, { ...ctx, planName: track.name, focus: track.focus }, { name: title ?? source.meta.title ?? source.name, type: source.type, note: source.meta.note }, chunks);
  await db.delete(requirements).where(and(eq(requirements.sourceId, source.id), eq(requirements.trackId, track.id)));
  await db.delete(clientQuestions).where(and(eq(clientQuestions.sourceId, source.id), eq(clientQuestions.trackId, track.id)));
  // Requirement numbers count within the test plan (shown as TP1-REQ-01).
  const existing = await db.select({ key: requirements.key }).from(requirements).where(eq(requirements.trackId, track.id));
  let n = nextNumber(existing.map((r) => r.key), "REQ");
  if (extracted.requirements.length) {
    await db.insert(requirements).values(
      extracted.requirements.map((r) => ({ projectId: source.projectId, sourceId: source.id, trackId: track.id, key: keyOf("REQ", n++, 2), title: r.title, text: r.text, area: r.area, acceptanceCriteria: r.acceptanceCriteria, sourceChunkIds: r.sourceChunkIds })),
    );
  }
  if (extracted.questions.length) {
    await db.insert(clientQuestions).values(extracted.questions.map((q) => ({ projectId: source.projectId, sourceId: source.id, trackId: track.id, question: q.question, why: q.why, sourceChunkIds: q.sourceChunkIds })));
  }
  return { usage: extracted.usage, requirements: extracted.requirements.length, questions: extracted.questions.length, dropped: extracted.report, model: extracted.model };
}

type IngestOutcome =
  | { ok: true; usage: Usage; requirements: number; questions: number; tracks: { id: string; requirements: number }[]; summary: Record<string, unknown> }
  | { ok: false; usage: Usage; error: string; needsTranscript: boolean; cause: unknown };

/**
 * Read, chunk and embed one source, then extract it for each test plan that uses it, keeping its status up to
 * date. Never throws: failures are recorded on the source and returned, with whatever the model calls cost.
 */
async function ingestSource(db: Db, source: Source, deps: AgentDeps, onStep: StepReport = async () => {}): Promise<IngestOutcome> {
  const log = deps.log ?? (() => {});
  const title = source.meta.title ?? source.name;
  await db.update(sources).set({ status: "ingesting", error: null }).where(eq(sources.id, source.id));
  let usage = NO_USAGE;
  try {
    const file = source.fileUri ? await readFile(artefactPath(source.fileUri)) : undefined;
    log(`reading ${source.type} source "${source.name}"`);
    // Plans that will read it aren't known yet; assume one extraction step after reading.
    await onStep({ label: `Reading ${title}`, index: 0, count: 2, expectSec: source.type === "loom" ? 15 : 10 });
    const { chunks, meta } = await readSource({ type: source.type as SourceType, file, link: source.uri }, deps.fetch);
    log(`${chunks.length} chunks`);

    let vectors: number[][] | null = null;
    let embedError: string | undefined;
    if (deps.embedder) {
      try {
        vectors = await deps.embedder.embed(chunks.map((c) => (c.sectionPath ? `${c.sectionPath}\n${c.text}` : c.text)));
      } catch (e) {
        embedError = (e as Error).message;
        log(`embedding failed, storing chunks without vectors: ${embedError}`);
      }
    }

    // Re-ingesting (e.g. after a transcript is attached) replaces this source's chunks, requirements and questions.
    await db.delete(requirements).where(eq(requirements.sourceId, source.id));
    await db.delete(clientQuestions).where(eq(clientQuestions.sourceId, source.id));
    await db.delete(sourceChunks).where(eq(sourceChunks.sourceId, source.id));
    const stored = await db
      .insert(sourceChunks)
      .values(chunks.map((c, i) => ({ sourceId: source.id, position: c.position, sectionPath: c.sectionPath, locator: c.locator, text: c.text, embedding: vectors?.[i] ?? null })))
      .returning({ id: sourceChunks.id, position: sourceChunks.position });
    const idAt = new Map(stored.map((s) => [s.position, s.id]));
    const storedChunks = chunks.map((c) => ({ ...c, id: idAt.get(c.position)! }));

    // An older version of the same document no longer feeds the plans: same link, or for uploads the same name.
    // Confluence pages match by link only, since two pages in a space can share a title.
    const sameDoc = source.uri ? (source.type === "confluence" ? eq(sources.uri, source.uri) : or(eq(sources.uri, source.uri), eq(sources.name, source.name))) : eq(sources.name, source.name);
    const older = (
      await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.projectId, source.projectId), ne(sources.id, source.id), sql`${sources.version} < ${source.version}`, sameDoc))
    ).map((o) => o.id);

    // Test plans that picked the older version use this one instead.
    const tracks = await projectTracks(db, source.projectId);
    for (const t of tracks) {
      if (t.sourceIds && older.some((id) => t.sourceIds!.includes(id)) && !t.sourceIds.includes(source.id)) {
        t.sourceIds = [...t.sourceIds.filter((id) => !older.includes(id)), source.id];
        await db.update(planTracks).set({ sourceIds: t.sourceIds }).where(eq(planTracks.id, t.id));
      }
    }
    const using = tracks.filter((t) => usesSource(t, source.id));

    const ctx = await projectContext(db, source.projectId, deps);
    const perTrack: { id: string; name: string; requirements: number; questions: number }[] = [];
    let dropped: unknown;
    let model: string | undefined;
    for (const [i, t] of using.entries()) {
      log(`extracting requirements for "${t.name}"`);
      await onStep({
        label: tracks.length > 1 ? `Claude is reading ${meta.title ?? title} for ${t.name}` : `Claude is extracting requirements from ${meta.title ?? title}`,
        index: 1 + i,
        count: 1 + using.length,
        expectSec: extractSecs(chunks.length),
      });
      const out = await extractInto(db, deps, ctx, source, t, storedChunks, meta.title);
      usage = addUsage(usage, out.usage);
      perTrack.push({ id: t.id, name: t.name, requirements: out.requirements, questions: out.questions });
      dropped = out.dropped;
      model = out.model;
    }

    if (older.length) {
      await db.update(sources).set({ status: "superseded" }).where(inArray(sources.id, older));
      await db.update(requirements).set({ reviewState: "superseded" }).where(inArray(requirements.sourceId, older));
      // Questions about the old version are no longer the client's to answer.
      await db.update(clientQuestions).set({ status: "withdrawn" }).where(and(inArray(clientQuestions.sourceId, older), eq(clientQuestions.status, "open")));
    }

    await db
      .update(sources)
      .set({ status: "ready", error: null, meta: { ...source.meta, ...meta, chunks: chunks.length } })
      .where(eq(sources.id, source.id));
    const reqCount = perTrack.reduce((n, t) => n + t.requirements, 0);
    const questionCount = perTrack.reduce((n, t) => n + t.questions, 0);
    return {
      ok: true,
      usage,
      requirements: reqCount,
      questions: questionCount,
      tracks: perTrack.map((t) => ({ id: t.id, requirements: t.requirements })),
      summary: {
        chunks: chunks.length,
        embedded: !!vectors,
        ...(embedError ? { embedError } : {}),
        requirements: reqCount,
        questions: questionCount,
        plans: perTrack,
        ...(using.length ? {} : { notInAnyPlan: true }),
        ...(dropped ? { dropped } : {}),
        ...(model ? { model } : {}),
        // What the agent was told, kept with the run so a reviewer can see why the output looks the way it does.
        ...(ctx.instructions?.trim() ? { instructions: ctx.instructions.trim() } : {}),
        ...(source.meta.note ? { sourceNote: source.meta.note } : {}),
        ...(ctx.guidelinesVersion ? { guidelinesVersion: ctx.guidelinesVersion } : {}),
      },
    };
  } catch (e) {
    if (e instanceof NeedsTranscript) {
      await db.update(sources).set({ status: "needs-transcript", error: e.message }).where(eq(sources.id, source.id));
      return { ok: false, usage, error: e.message, needsTranscript: true, cause: e };
    }
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    const message = (e as Error).message;
    await db.update(sources).set({ status: "failed", error: message }).where(eq(sources.id, source.id));
    return { ok: false, usage, error: message, needsTranscript: false, cause: e };
  }
}

/** Queue a plan run after ingest, as a child of the ingest task. */
async function queuePlanAfter(db: Db, deps: AgentDeps, projectId: string, parentTaskId: string, params: Record<string, unknown>, trackIds: string[]) {
  const names = new Map((await db.select({ id: planTracks.id, name: planTracks.name }).from(planTracks).where(eq(planTracks.projectId, projectId))).map((t) => [t.id, t.name]));
  for (const trackId of new Set(trackIds)) {
    const name = names.get(trackId);
    const [task] = await db
      .insert(tasks)
      .values({ projectId, kind: "plan", trigger: "manual", title: names.size > 1 && name ? `Draft test plan: ${name}` : "Draft test plan", params: { ...params, trackId }, parentTaskId })
      .returning();
    const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
    await deps.queuePlan({ taskId: task!.id, runId: run!.id, projectId, trackId });
  }
}

/** Read, chunk, embed and extract one source; then queue a plan run. */
export async function runIngest(db: Db, job: IngestJob, deps: AgentDeps) {
  await start(db, job.taskId, job.runId);
  const [source] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
  if (!source) {
    await finish(db, job.taskId, job.runId, "failed", NO_USAGE, { error: "Source not found" });
    return;
  }
  const out = await ingestSource(db, source, deps, (st) => progress(db, job.runId, { label: st.label, done: st.index / st.count, total: 1, stepWeight: 1 / st.count, expectSec: st.expectSec }));
  if (!out.ok) {
    if (out.needsTranscript) {
      await finish(db, job.taskId, job.runId, "needs-review", out.usage, { needsTranscript: true, error: out.error });
      return;
    }
    await finish(db, job.taskId, job.runId, "failed", out.usage, { error: out.error });
    throw out.cause;
  }
  await finish(db, job.taskId, job.runId, "done", out.usage, out.summary);
  if (job.thenPlan) await queuePlanAfter(db, deps, source.projectId, job.taskId, { sourceId: source.id }, out.tracks.filter((t) => t.requirements).map((t) => t.id));
}

/**
 * Add a Confluence page (and its child pages), or with `sync` re-check every Confluence page in the project.
 * Each page is its own source. Pages whose Confluence version hasn't changed are skipped; new and changed pages
 * are saved as HTML, ingested here one after another, and one plan run follows.
 */
export async function runConfluence(db: Db, job: ConfluenceJob, deps: AgentDeps) {
  const log = deps.log ?? (() => {});
  await start(db, job.taskId, job.runId);
  let usage = NO_USAGE;
  const counts = { pages: 0, added: 0, changed: 0, unchanged: 0, failed: 0, requirements: 0, questions: 0 };
  const problems: string[] = [];
  try {
    const cfg = deps.confluence;
    if (!cfg) throw new ConfluenceError(NOT_SET_UP);
    const f = deps.fetch ?? fetch;

    type Root = { pageId: string; includeChildren: boolean; folder?: boolean; title?: string };
    let roots: Root[];
    if (job.sync) {
      const live = await db
        .select()
        .from(sources)
        .where(and(eq(sources.projectId, job.projectId), eq(sources.type, "confluence"), notInArray(sources.status, ["superseded", "removed"])));
      const byRoot = new Map<string, Root>();
      for (const s of live) {
        const c = s.meta.confluence;
        if (!c) continue;
        // A folder has no page of its own: its pages carry rootKind, and the whole folder is read again.
        const root = byRoot.get(c.rootPageId) ?? (c.rootKind === "folder" ? { pageId: c.rootPageId, includeChildren: true, folder: true } : { pageId: c.rootPageId, includeChildren: false });
        if (c.pageId === c.rootPageId) Object.assign(root, { includeChildren: !!c.includeChildren, title: s.name });
        byRoot.set(c.rootPageId, root);
      }
      roots = [...byRoot.values()];
      if (!roots.length) throw new ConfluenceError("There are no Confluence pages in this project yet.");
    } else {
      if (!job.link) throw new ConfluenceError("No Confluence link was given.");
      const r = await resolveRoot(cfg, job.link, f);
      roots = [r.kind === "folder" ? { pageId: r.id, includeChildren: true, folder: true } : { pageId: r.id, includeChildren: job.includeChildren }];
    }

    await progress(db, job.runId, { label: job.sync ? "Checking Confluence for changes" : "Reading pages from Confluence", done: 0, total: 1, stepWeight: 1, expectSec: 8 });
    const seen = new Set<string>();
    const toIngest: Source[] = [];
    const planTrackIds: string[] = [];
    for (const root of roots) {
      let tree: Awaited<ReturnType<typeof readPageTree>>;
      try {
        log(root.folder ? `reading the pages in Confluence folder ${root.pageId}` : `reading Confluence page ${root.pageId}${root.includeChildren ? " and its child pages" : ""}`);
        tree = await readPageTree(cfg, root.pageId, { includeChildren: root.includeChildren, folder: root.folder }, f);
      } catch (e) {
        if (!job.sync || !(e instanceof ConfluenceError)) throw e;
        problems.push(`${root.title ?? `Page ${root.pageId}`}: ${e.message}`);
        continue;
      }
      if (tree.truncated) problems.push(`Only the first ${CONFLUENCE_MAX_PAGES} pages under "${tree.rootTitle}" were read.`);
      if (!tree.pages.length) {
        if (!job.sync) throw new ConfluenceError(`The folder "${tree.rootTitle}" has no pages in it.`);
        problems.push(`${tree.rootTitle}: the folder has no pages in it.`);
        continue;
      }
      for (const page of tree.pages) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        const uri = confluencePageUrl(cfg.origin, page.id);
        const [latest] = await db
          .select()
          .from(sources)
          .where(and(eq(sources.projectId, job.projectId), eq(sources.uri, uri)))
          .orderBy(desc(sources.version))
          .limit(1);
        const isRoot = page.id === root.pageId;
        // A page the team removed stays out of update checks until they restore it, even if it changes in
        // Confluence. Adding it again (on its own or in a folder) reads it as a new version.
        const readded = latest?.status === "removed" && !job.sync;
        if (latest?.status === "removed" && job.sync) {
          counts.unchanged++;
          continue;
        }
        if (latest && !readded && latest.meta.confluence?.version === page.version) {
          // Same content, but it failed last time or the job was cut off before reading it: read it now.
          if (latest.status === "failed" || latest.status === "queued" || latest.status === "ingesting") {
            toIngest.push(latest);
            // A page never read (the job was cut off) counts as new; one that failed is read again.
            if (latest.status === "failed" || latest.version > 1) counts.changed++;
            else counts.added++;
          } else {
            counts.unchanged++;
          }
          continue;
        }
        if (!page.html.trim()) {
          problems.push(`${page.title}: the page is empty.`);
          continue;
        }
        const data = Buffer.from(page.html, "utf8");
        const hash = createHash("sha256").update(data).digest("hex");
        const fileUri = `sources/${job.projectId}/${hash.slice(0, 16)}-confluence-${page.id}.html`;
        await mkdir(dirname(artefactPath(fileUri)), { recursive: true });
        await writeFile(artefactPath(fileUri), data);
        const [source] = await db
          .insert(sources)
          .values({
            projectId: job.projectId,
            type: "confluence",
            name: page.title,
            uri,
            fileUri,
            contentHash: hash,
            version: (latest?.version ?? 0) + 1,
            meta: {
              title: page.title,
              // A note given when adding applies to every page read through it; a re-read keeps the page's last note
              // (a removed page added again starts afresh).
              ...((job.note ?? (readded ? undefined : latest?.meta.note)) ? { note: job.note ?? latest?.meta.note } : {}),
              confluence: { pageId: page.id, version: page.version, webUrl: page.webUrl, rootPageId: root.pageId, ...(isRoot ? { includeChildren: root.includeChildren } : {}), ...(root.folder ? { rootKind: "folder" as const } : {}), rootTitle: tree.rootTitle },
            },
            createdBy: job.requestedBy ?? null,
          })
          .returning();
        if (latest && !readded) counts.changed++;
        else counts.added++;
        toIngest.push(source!);
      }
    }
    counts.pages = seen.size;

    for (const [n, source] of toIngest.entries()) {
      const out = await ingestSource(db, source, deps, (st) =>
        progress(db, job.runId, { label: `Page ${n + 1} of ${toIngest.length}: ${st.label}`, done: n + st.index / st.count, total: toIngest.length, stepWeight: 1 / st.count, expectSec: st.expectSec }),
      );
      usage = addUsage(usage, out.usage);
      if (out.ok) {
        counts.requirements += out.requirements;
        counts.questions += out.questions;
        planTrackIds.push(...out.tracks.filter((t) => t.requirements).map((t) => t.id));
      } else {
        counts.failed++;
        problems.push(`${source.name}: ${out.error}`);
      }
    }

    const allFailed = toIngest.length > 0 && counts.failed === toIngest.length;
    await finish(db, job.taskId, job.runId, allFailed ? "failed" : "done", usage, {
      ...counts,
      ...(problems.length ? { problems } : {}),
      ...(allFailed ? { error: problems[0] } : {}),
    });
    const others = planTrackIds.filter((t) => t !== job.thenTrackId);
    if (others.length) await queuePlanAfter(db, deps, job.projectId, job.taskId, { confluence: true }, others);
    await draftAfterCheck(db, deps, job);
  } catch (e) {
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    await finish(db, job.taskId, job.runId, "failed", usage, { ...counts, error: (e as Error).message, ...(problems.length ? { problems } : {}) });
    if (!(e instanceof ConfluenceError)) throw e;
    // Confluence couldn't be reached: the plan is still drafted, from the pages as they were last read.
    await draftAfterCheck(db, deps, job);
  }
}

/** "Draft again" asked for this check first: now read the plan's unread sources and draft it. */
async function draftAfterCheck(db: Db, deps: AgentDeps, job: ConfluenceJob) {
  if (!job.thenTrackId || !deps.queueTrack) return;
  const [track] = await db.select({ name: planTracks.name }).from(planTracks).where(and(eq(planTracks.id, job.thenTrackId), eq(planTracks.projectId, job.projectId)));
  if (!track) return;
  const [task] = await db
    .insert(tasks)
    .values({ projectId: job.projectId, kind: "plan", trigger: "manual", title: `Draft test plan: ${track.name}`, params: { trackId: job.thenTrackId, refresh: true, requestedBy: job.requestedBy }, parentTaskId: job.taskId })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  await deps.queueTrack({ taskId: task!.id, runId: run!.id, projectId: job.projectId, trackId: job.thenTrackId, refresh: true });
}

/**
 * Start a new test plan: extract each of its sources (already read and chunked) again with the plan's focus, then
 * queue a plan run for its first version. Other test plans are untouched.
 */
export async function runTrack(db: Db, job: TrackJob, deps: AgentDeps) {
  const log = deps.log ?? (() => {});
  await start(db, job.taskId, job.runId);
  let usage = NO_USAGE;
  try {
    const [track] = await db.select().from(planTracks).where(and(eq(planTracks.id, job.trackId), eq(planTracks.projectId, job.projectId)));
    if (!track) throw new Error("Test plan not found");
    const ready = (await db.select().from(sources).where(and(eq(sources.projectId, job.projectId), eq(sources.status, "ready"))).orderBy(sources.createdAt)).filter((x) => usesSource(track, x.id));
    if (!ready.length) throw new Error("None of this plan's sources are ready to read. Add a source or pick another.");
    if (job.reset) {
      await db.delete(requirements).where(eq(requirements.trackId, track.id));
      await db.delete(clientQuestions).where(eq(clientQuestions.trackId, track.id));
    }
    // "Draft again": keep what this plan has already read, drop what came from sources it no longer reads, and read
    // only the sources it hasn't read yet.
    let toRead = ready;
    if (job.refresh) {
      if (track.sourceIds) {
        const kept = track.sourceIds.length ? track.sourceIds : ["00000000-0000-0000-0000-000000000000"];
        await db.delete(requirements).where(and(eq(requirements.trackId, track.id), notInArray(requirements.sourceId, kept)));
        await db.delete(clientQuestions).where(and(eq(clientQuestions.trackId, track.id), notInArray(clientQuestions.sourceId, kept)));
      }
      const readBefore = new Set([
        ...(await db.selectDistinct({ id: requirements.sourceId }).from(requirements).where(eq(requirements.trackId, track.id))).map((r) => r.id),
        ...(await db.selectDistinct({ id: clientQuestions.sourceId }).from(clientQuestions).where(eq(clientQuestions.trackId, track.id))).map((r) => r.id),
      ]);
      toRead = ready.filter((x) => !readBefore.has(x.id));
    }
    const ctx = await projectContext(db, job.projectId, deps);
    let reqCount = 0;
    let questionCount = 0;
    for (const [n, source] of toRead.entries()) {
      const rows = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source.id)).orderBy(sourceChunks.position);
      const chunks: StoredChunk[] = rows.map((c) => ({ id: c.id, position: c.position, sectionPath: c.sectionPath, locator: c.locator, text: c.text }));
      if (!chunks.length) continue;
      await progress(db, job.runId, {
        label: `${toRead.length > 1 ? `Source ${n + 1} of ${toRead.length}: ` : ""}Claude is reading ${source.meta.title ?? source.name} for ${track.name}`,
        done: n,
        total: toRead.length,
        stepWeight: 1,
        expectSec: extractSecs(chunks.length),
      });
      log(`extracting "${source.meta.title ?? source.name}" for "${track.name}"`);
      const out = await extractInto(db, deps, ctx, source, track, chunks);
      usage = addUsage(usage, out.usage);
      reqCount += out.requirements;
      questionCount += out.questions;
    }
    // A refresh drafts from everything the plan has, not just what was read now.
    const [have] = job.refresh ? await db.select({ n: sql<number>`count(*)::int` }).from(requirements).where(eq(requirements.trackId, track.id)) : [{ n: reqCount }];
    const total = have?.n ?? 0;
    await finish(db, job.taskId, job.runId, "done", usage, {
      plan: track.name,
      ...(track.focus ? { focus: track.focus } : {}),
      sources: toRead.length,
      requirements: reqCount,
      questions: questionCount,
      ...(total ? {} : { error: "The sources say nothing within this plan's focus." }),
      ...(ctx.instructions?.trim() ? { instructions: ctx.instructions.trim() } : {}),
      ...(ctx.guidelinesVersion ? { guidelinesVersion: ctx.guidelinesVersion } : {}),
    });
    if (total) await queuePlanAfter(db, deps, job.projectId, job.taskId, job.refresh ? {} : { newPlan: true }, [track.id]);
  } catch (e) {
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    await finish(db, job.taskId, job.runId, "failed", usage, { error: (e as Error).message });
    throw e;
  }
}

/** Draft a new version of one test plan from its live requirements. */
export async function runPlan(db: Db, job: PlanJob, deps: AgentDeps) {
  const log = deps.log ?? (() => {});
  await start(db, job.taskId, job.runId);
  let usage = NO_USAGE;
  try {
    const tracks = await projectTracks(db, job.projectId);
    const track = job.trackId ? tracks.find((t) => t.id === job.trackId) : tracks[0];
    if (!track) throw new Error("Test plan not found");
    const reqs = await db
      .select({ r: requirements })
      .from(requirements)
      .innerJoin(sources, eq(sources.id, requirements.sourceId))
      .where(and(eq(requirements.projectId, job.projectId), eq(requirements.trackId, track.id), inArray(requirements.reviewState, ["needs-review", "approved"]), eq(sources.status, "ready")))
      .orderBy(requirements.key);
    if (!reqs.length) throw new Error("There are no requirements to plan from. Add a source first.");

    const sourceIds = [...new Set(reqs.map((x) => x.r.sourceId!))];
    const all = await db
      .select({ c: sourceChunks, sourceName: sources.name, sourceType: sources.type, title: sql<string | null>`${sources.meta}->>'title'`, note: sql<string | null>`${sources.meta}->>'note'` })
      .from(sourceChunks)
      .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
      .where(inArray(sourceChunks.sourceId, sourceIds))
      .orderBy(sources.createdAt, sourceChunks.position);
    const cited = new Set(reqs.flatMap((x) => x.r.sourceChunkIds));
    const total = all.reduce((n, x) => n + x.c.text.length, 0);
    const shown = total <= PLAN_CONTEXT_CHARS ? all : all.filter((x) => cited.has(x.c.id));
    const chunks: PlanInputChunk[] = shown.map((x) => ({ ...x.c, sourceName: x.title ?? x.sourceName, sourceType: x.sourceType }));

    const questions = await db.select({ q: clientQuestions.question }).from(clientQuestions).where(and(eq(clientQuestions.projectId, job.projectId), eq(clientQuestions.trackId, track.id), eq(clientQuestions.status, "open")));
    const ctx = { ...(await projectContext(db, job.projectId, deps)), planName: track.name, focus: track.focus };

    // Approved work moves into the new plan unchanged: approved user stories, and approved test cases with their
    // scenarios. Claude sees it, plans around it and doesn't redraft it. Work whose requirements have all gone
    // (source removed or replaced) stays behind with the old plan.
    const liveKeys = new Set(reqs.map((x) => x.r.key));
    const activePlans = db.select({ id: testPlans.id }).from(testPlans).where(and(eq(testPlans.trackId, track.id), ne(testPlans.status, "superseded")));
    const approvedStories = (
      await db.select().from(userStories).where(and(inArray(userStories.planId, activePlans), eq(userStories.reviewState, "approved"))).orderBy(userStories.key)
    ).filter((st) => st.requirementIds.some((k) => liveKeys.has(k)));
    const keptRefOfStory = new Map(approvedStories.map((st, i) => [st.id, `A${i + 1}`]));
    const approvedRows = await db
      .select({ c: testCases, s: scenarios })
      .from(testCases)
      .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
      .where(and(inArray(scenarios.planId, activePlans), eq(testCases.reviewState, "approved")))
      .orderBy(scenarios.position, testCases.key);
    const keptScenarios = new Map<string, { s: (typeof approvedRows)[number]["s"]; cases: (typeof approvedRows)[number]["c"][] }>();
    for (const row of approvedRows) {
      if (!row.s.requirementIds.some((k) => liveKeys.has(k))) continue;
      const entry = keptScenarios.get(row.s.id) ?? { s: row.s, cases: [] };
      entry.cases.push(row.c);
      keptScenarios.set(row.s.id, entry);
    }
    const kept: KeptWork = {
      stories: approvedStories.map((st) => ({
        ref: keptRefOfStory.get(st.id)!,
        key: st.key,
        title: st.title,
        actor: st.actor,
        want: st.want,
        soThat: st.soThat,
        requirementKeys: st.requirementIds.filter((k) => liveKeys.has(k)),
        critical: st.critical,
      })),
      scenarios: [...keptScenarios.values()].map(({ s: x, cases }) => ({
        key: x.key,
        title: x.title,
        kind: x.kind,
        priority: x.priority,
        requirementKeys: x.requirementIds.filter((k) => liveKeys.has(k)),
        storyRef: x.storyId ? (keptRefOfStory.get(x.storyId) ?? null) : null,
        cases: cases.map((c) => ({ key: c.key, title: c.title })),
      })),
    };
    log(`planning from ${reqs.length} requirements and ${chunks.length} passages; keeping ${kept.stories.length} approved stories and ${approvedRows.length} approved test cases`);
    await progress(db, job.runId, {
      label: `Claude is drafting ${tracks.length > 1 ? `the ${track.name} plan` : "the plan"}: user stories, scenarios and test cases from ${reqs.length} requirements`,
      done: 0,
      total: 1,
      stepWeight: 0.95,
      expectSec: await planSecs(db, job.projectId),
    });
    const drafted = await draftPlan(
      deps.model,
      ctx,
      reqs.map((x) => ({ key: x.r.key, title: x.r.title, text: x.r.text, area: x.r.area, acceptanceCriteria: x.r.acceptanceCriteria, sourceChunkIds: x.r.sourceChunkIds })),
      chunks,
      questions.map((q) => q.q),
      [...new Map(all.filter((x) => x.note).map((x) => [x.c.sourceId, { source: x.title ?? x.sourceName, note: x.note! }])).values()],
      kept,
    );
    usage = drafted.usage;

    const [prev] = await db.select({ version: testPlans.version }).from(testPlans).where(eq(testPlans.trackId, track.id)).orderBy(desc(testPlans.version)).limit(1);
    // Numbers count within the test plan (shown as TP1-TC-004) and continue after the test cases and stories
    // someone has reviewed (approved, rejected or edited), so a number that may be referenced elsewhere is never
    // reused. Unreviewed drafts are throwaway: their numbers recycle.
    const reviewed = ["approved", "rejected"];
    const keys = await db
      .select({ key: testCases.key })
      .from(testCases)
      .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
      .innerJoin(testPlans, eq(testPlans.id, scenarios.planId))
      .where(and(eq(testPlans.trackId, track.id), or(inArray(testCases.reviewState, reviewed), eq(testCases.edited, true))));
    let tc = nextNumber(keys.map((k) => k.key), "TC");
    // A scenario's number is kept once any of its test cases has been reviewed or edited.
    const scenarioKeys = await db
      .selectDistinct({ key: scenarios.key })
      .from(scenarios)
      .innerJoin(testPlans, eq(testPlans.id, scenarios.planId))
      .innerJoin(testCases, eq(testCases.scenarioId, scenarios.id))
      .where(and(eq(testPlans.trackId, track.id), or(inArray(testCases.reviewState, reviewed), eq(testCases.edited, true))));
    let sc = nextNumber(scenarioKeys.flatMap((k) => (k.key ? [k.key] : [])), "SC");
    const storyKeys = await db
      .select({ key: userStories.key })
      .from(userStories)
      .innerJoin(testPlans, eq(testPlans.id, userStories.planId))
      .where(and(eq(testPlans.trackId, track.id), inArray(userStories.reviewState, reviewed)));
    let us = nextNumber(storyKeys.map((k) => k.key), "US");

    // Stories: approved ones first (keeping their keys), then new ones with project-wide keys (US-07) in Claude's order.
    const allStories = [...kept.stories.map((st) => ({ ref: st.ref, requirementKeys: st.requirementKeys })), ...drafted.stories];
    const storyOrder = new Map(allStories.map((st, i) => [st.ref, i]));
    const keyOfStory = new Map<string, string>([...kept.stories.map((st) => [st.ref, st.key] as [string, string]), ...drafted.stories.map((st) => [st.ref, keyOf("US", us++, 2)] as [string, string])]);
    // An approved scenario whose story wasn't approved joins the story that shares most of its requirements.
    const bestStory = (keys: string[]) => {
      let best: { ref: string; n: number } | null = null;
      for (const st of allStories) {
        const n = st.requirementKeys.filter((k) => keys.includes(k)).length;
        if (n && (!best || n > best.n)) best = { ref: st.ref, n };
      }
      return best?.ref ?? null;
    };
    type Entry = { storyRef: string | null; i: number } & ({ kind: "kept"; row: (typeof approvedRows)[number]["s"]; cases: (typeof approvedRows)[number]["c"][] } | { kind: "new"; draft: (typeof drafted.scenarios)[number] });
    const entries: Entry[] = [
      ...[...keptScenarios.values()].map(({ s: row, cases }, i): Entry => ({ kind: "kept", row, cases, storyRef: (row.storyId && keptRefOfStory.get(row.storyId)) || bestStory(row.requirementIds), i })),
      ...drafted.scenarios.map((d, i): Entry => ({ kind: "new", draft: d, storyRef: d.storyRef, i: keptScenarios.size + i })),
    ];
    // Keep each story's scenarios together (approved first, gap-filled ones no longer last), in story order.
    const ordered = entries.sort((a, b) => (storyOrder.get(a.storyRef ?? "") ?? Infinity) - (storyOrder.get(b.storyRef ?? "") ?? Infinity) || a.i - b.i);
    const gaps = drafted.plan.gaps.map((g) => ({ ...g, key: keyOfStory.get(g.key) ?? g.key }));

    await progress(db, job.runId, { label: "Saving the plan", done: 0.95, total: 1, stepWeight: 0.05, expectSec: 3 });
    const caseCount = await db.transaction(async (tx) => {
      // Earlier drafts give way to the new one; anything already approved stays approved.
      const oldPlans = await tx.select({ id: testPlans.id }).from(testPlans).where(and(eq(testPlans.trackId, track.id), eq(testPlans.status, "draft")));
      if (oldPlans.length) {
        const ids = oldPlans.map((p) => p.id);
        await tx.update(testPlans).set({ status: "superseded" }).where(inArray(testPlans.id, ids));
        const scen = await tx.select({ id: scenarios.id }).from(scenarios).where(inArray(scenarios.planId, ids));
        if (scen.length) await tx.update(testCases).set({ reviewState: "superseded" }).where(and(inArray(testCases.scenarioId, scen.map((s) => s.id)), eq(testCases.reviewState, "needs-review")));
      }
      const [plan] = await tx
        .insert(testPlans)
        .values({ projectId: job.projectId, trackId: track.id, taskId: job.taskId, name: drafted.plan.name, version: (prev?.version ?? 0) + 1, status: "draft", body: { summary: drafted.plan.summary, scope: drafted.plan.scope, outOfScope: drafted.plan.outOfScope, risks: drafted.plan.risks, critical: drafted.plan.critical, gaps }, sourceIds })
        .returning();
      const storyIds = new Map<string, string>();
      for (const [i, st] of approvedStories.entries()) {
        const { id: _id, planId: _plan, position: _pos, ...rest } = st;
        const [row] = await tx.insert(userStories).values({ ...rest, planId: plan!.id, position: i }).returning({ id: userStories.id });
        storyIds.set(keptRefOfStory.get(st.id)!, row!.id);
      }
      for (const [j, st] of drafted.stories.entries()) {
        const i = approvedStories.length + j;
        const [row] = await tx
          .insert(userStories)
          .values({
            planId: plan!.id,
            key: keyOfStory.get(st.ref)!,
            title: st.title,
            actor: st.actor,
            want: st.want,
            soThat: st.soThat,
            acceptanceCriteria: st.acceptanceCriteria,
            requirementIds: st.requirementKeys,
            priority: st.priority,
            critical: st.critical,
            criticalWhy: st.criticalWhy,
            position: i,
          })
          .returning({ id: userStories.id });
        storyIds.set(st.ref, row!.id);
      }
      let cases = 0;
      for (const [i, e] of ordered.entries()) {
        const storyId = e.storyRef ? (storyIds.get(e.storyRef) ?? null) : null;
        if (e.kind === "kept") {
          // Same scenario (same SC number) in the new plan; its approved test cases move across with their ids and numbers.
          const { id: _id, planId: _plan, position: _pos, storyId: _story, ...rest } = e.row;
          const [scen] = await tx.insert(scenarios).values({ ...rest, key: rest.key ?? keyOf("SC", sc++, 3), planId: plan!.id, storyId, position: i }).returning({ id: scenarios.id });
          await tx.update(testCases).set({ scenarioId: scen!.id }).where(inArray(testCases.id, e.cases.map((c) => c.id)));
          continue;
        }
        const s = e.draft;
        const [scen] = await tx.insert(scenarios).values({ planId: plan!.id, key: keyOf("SC", sc++, 3), storyId, title: s.title, actor: s.actor, situation: s.situation, outcome: s.outcome, priority: s.priority, kind: s.kind, requirementIds: s.requirementKeys, position: i }).returning();
        await tx.insert(testCases).values(
          s.testCases.map((c) => ({
            scenarioId: scen!.id,
            key: keyOf("TC", tc++, 3),
            title: c.title,
            preconditions: c.preconditions,
            testData: c.testData,
            steps: c.steps,
            type: "manual",
            automationCandidate: c.automationCandidate,
            sourceChunkIds: c.sourceChunkIds,
          })),
        );
        cases += s.testCases.length;
      }
      return cases;
    });

    await finish(db, job.taskId, job.runId, "done", usage, {
      plan: track.name,
      requirements: reqs.length,
      scenarios: drafted.scenarios.length,
      testCases: caseCount,
      ...(kept.stories.length || approvedRows.length ? { kept: { stories: kept.stories.length, scenarios: keptScenarios.size, testCases: [...keptScenarios.values()].reduce((n, x) => n + x.cases.length, 0) } } : {}),
      passages: chunks.length,
      stories: drafted.stories.length,
      critical: drafted.plan.critical.length,
      gapsFound: drafted.report.gapsFound,
      gapsFilled: drafted.report.gapsFilled,
      ...(gaps.length ? { gapsLeft: gaps } : {}),
      dropped: drafted.report,
      model: drafted.model,
      ...(ctx.instructions?.trim() ? { instructions: ctx.instructions.trim() } : {}),
      ...(ctx.guidelinesVersion ? { guidelinesVersion: ctx.guidelinesVersion } : {}),
    });
  } catch (e) {
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    await finish(db, job.taskId, job.runId, "failed", usage, { error: (e as Error).message });
    throw e;
  }
}
