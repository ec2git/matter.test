import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { loomLinkAt, type ChunkLocator } from "@mattertest/core";
import { clientQuestions, planTracks, requirements, runs, scenarios, sourceChunks, sources, tasks, testCases, testPlans, userStories } from "@mattertest/db";
import { db } from "@/lib/server";

export type SourceRow = typeof sources.$inferSelect;
export type RequirementRow = typeof requirements.$inferSelect;
export type PlanRow = typeof testPlans.$inferSelect;
export type ScenarioRow = typeof scenarios.$inferSelect;
export type StoryRow = typeof userStories.$inferSelect;
export type TestCaseRow = typeof testCases.$inferSelect;
export type QuestionRow = typeof clientQuestions.$inferSelect;
export type TrackRow = typeof planTracks.$inferSelect;

/** Display name of a source: a Loom video's title once known, else the file name. */
export const sourceTitle = (s: Pick<SourceRow, "name" | "meta">) => s.meta.title ?? s.name;

/** A project's sources, newest first; older versions of a document and removed sources are left out. */
export async function projectSources(projectId: string): Promise<SourceRow[]> {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.projectId, projectId), notInArray(sources.status, ["superseded", "removed"])))
    .orderBy(desc(sources.createdAt));
}

/** Sources the team removed from the project, newest first; they can be restored. */
export async function removedSources(projectId: string): Promise<SourceRow[]> {
  return db.select().from(sources).where(and(eq(sources.projectId, projectId), eq(sources.status, "removed"))).orderBy(desc(sources.createdAt));
}

/** A project's test plans, in the order they were made. */
export async function projectTracks(projectId: string): Promise<TrackRow[]> {
  return db.select().from(planTracks).where(eq(planTracks.projectId, projectId)).orderBy(asc(planTracks.position), asc(planTracks.createdAt));
}

/**
 * Requirements that feed a plan: not superseded by a newer source version, and not from a removed source.
 * With a test plan, only the ones extracted for it.
 */
export async function liveRequirements(projectId: string, trackId?: string): Promise<RequirementRow[]> {
  const rows = await db
    .select({ r: requirements })
    .from(requirements)
    .leftJoin(sources, eq(sources.id, requirements.sourceId))
    .where(and(eq(requirements.projectId, projectId), trackId ? eq(requirements.trackId, trackId) : undefined, ne(requirements.reviewState, "superseded"), or(isNull(sources.id), ne(sources.status, "removed"))))
    .orderBy(asc(requirements.key));
  return rows.map((x) => x.r);
}

export type PlanTree = { plan: PlanRow; stories: StoryRow[]; scenarios: (ScenarioRow & { cases: TestCaseRow[] })[] };

/** A test plan's newest version that hasn't been superseded, with its stories, scenarios and test cases. */
export async function currentPlan(trackId: string): Promise<PlanTree | null> {
  const [plan] = await db
    .select()
    .from(testPlans)
    .where(and(eq(testPlans.trackId, trackId), ne(testPlans.status, "superseded")))
    .orderBy(desc(testPlans.version))
    .limit(1);
  if (!plan) return null;
  const [scen, stories] = await Promise.all([
    db.select().from(scenarios).where(eq(scenarios.planId, plan.id)).orderBy(asc(scenarios.position)),
    db.select().from(userStories).where(eq(userStories.planId, plan.id)).orderBy(asc(userStories.position)),
  ]);
  const cases = scen.length ? await db.select().from(testCases).where(inArray(testCases.scenarioId, scen.map((s) => s.id))).orderBy(asc(testCases.key)) : [];
  return { plan, stories, scenarios: scen.map((s) => ({ ...s, cases: cases.filter((c) => c.scenarioId === s.id) })) };
}

export async function projectQuestions(projectId: string, trackId?: string): Promise<QuestionRow[]> {
  return db.select().from(clientQuestions).where(and(eq(clientQuestions.projectId, projectId), trackId ? eq(clientQuestions.trackId, trackId) : undefined, ne(clientQuestions.status, "withdrawn"))).orderBy(sql`${clientQuestions.status} = 'open' desc`, asc(clientQuestions.createdAt));
}

export type AgentRun = {
  id: string;
  kind: string;
  title: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: Record<string, unknown> | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sourceId: string | null;
  /** The test plan a plan run drafted (or a new plan run started). */
  trackId: string | null;
  /** Added a Confluence page or checked Confluence for updates. */
  confluence: boolean;
};

/** Recent ingest and plan runs for a project, newest first. */
export async function agentRuns(projectId: string, limit = 10): Promise<AgentRun[]> {
  const rows = await db
    .select({
      id: runs.id,
      kind: tasks.kind,
      title: tasks.title,
      status: runs.status,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      summary: runs.summary,
      costUsd: runs.costUsd,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      sourceId: sql<string | null>`${tasks.params}->>'sourceId'`,
      trackId: sql<string | null>`coalesce(${tasks.params}->>'trackId', ${tasks.params}->>'thenTrackId')`,
      // Plan runs queued after a Confluence read carry its params too; only the read itself counts.
      confluence: sql<boolean>`${tasks.kind} = 'ingest' and coalesce((${tasks.params}->>'confluence')::boolean, false)`,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.kind, ["ingest", "plan"])))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
}

/** Agent spend across all projects since the start of this month (local time), and the monthly budget. */
export async function agentSpendThisMonth(): Promise<{ spent: number; budget: number }> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(inArray(tasks.kind, ["ingest", "plan", "sanity", "triage"]), gte(runs.createdAt, start)));
  return { spent: Number(row?.spent ?? 0), budget: Number(process.env.AGENT_MONTHLY_BUDGET_USD || 150) };
}

/** What a plan tree has waiting for review: the plan, stories, scenarios (waiting while any case is) and cases. */
export function treeWaiting(tree: PlanTree | null): number {
  if (!tree) return 0;
  const cases = tree.scenarios.reduce((n, s) => n + s.cases.filter((c) => c.reviewState === "needs-review").length, 0);
  const scenarioCount = tree.scenarios.filter((s) => !s.cases.some((c) => c.reviewState !== "superseded") || s.cases.some((c) => c.reviewState === "needs-review")).length;
  const stories = tree.stories.filter((st) => st.reviewState === "needs-review").length;
  return cases + scenarioCount + stories + (tree.plan.status === "draft" ? 1 : 0);
}

/** How many items wait in a project's Review inbox, across its test plans. */
export async function reviewCount(projectId: string): Promise<number> {
  const trees = await Promise.all((await projectTracks(projectId)).map((t) => currentPlan(t.id)));
  const waiting = trees.reduce((n, t) => n + treeWaiting(t), 0);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(requirements)
    .leftJoin(sources, eq(sources.id, requirements.sourceId))
    .where(and(eq(requirements.projectId, projectId), eq(requirements.reviewState, "needs-review"), or(isNull(sources.id), ne(sources.status, "removed"))));
  return waiting + (r?.n ?? 0);
}

export type Passage = {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sectionPath: string | null;
  locator: ChunkLocator;
  text: string;
  /** Where "open source" goes: the source view, or the Loom video at that moment. */
  href: string;
  videoHref: string | null;
  /** The Confluence page the passage came from. */
  pageHref: string | null;
};

/** Source passages by chunk id, in the order given. */
export async function passages(ids: string[]): Promise<Passage[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db
    .select({ c: sourceChunks, s: { id: sources.id, name: sources.name, meta: sources.meta, type: sources.type, uri: sources.uri } })
    .from(sourceChunks)
    .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
    .where(inArray(sourceChunks.id, unique));
  const byId = new Map(rows.map((r) => [r.c.id, r]));
  return unique.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const videoHref = r.s.type === "loom" && r.s.uri ? loomLinkAt(r.s.uri, r.c.locator.startSec) : null;
    return [{
      id,
      sourceId: r.s.id,
      sourceName: sourceTitle(r.s),
      sourceType: r.s.type,
      sectionPath: r.c.sectionPath,
      locator: r.c.locator,
      text: r.c.text,
      href: `/sources/${r.s.id}?hl=${id}#chunk-${id}`,
      videoHref,
      pageHref: r.s.type === "confluence" ? (r.s.meta.confluence?.webUrl ?? r.s.uri) : null,
    }];
  });
}

/** "Checkout-PRD.pdf · 5.2 Promo codes · p. 12" */
export function passageLabel(p: Pick<Passage, "sourceName" | "sectionPath" | "locator">): string {
  return [p.sourceName, p.sectionPath, p.locator.page && !p.sectionPath?.startsWith("Page") ? `p. ${p.locator.page}` : null].filter(Boolean).join(" · ");
}
