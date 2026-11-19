/** Ingest → plan against a real database with the model mocked. Needs a migrated Postgres at DATABASE_URL; skipped otherwise. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confluencePageUrl, type PlanJob } from "@mattertest/core";
import { clientQuestions, clients, createDb, planTracks, projects, requirements, runs, scenarios, sourceChunks, sources, tasks, testCases, testPlans, userStories, type Db } from "@mattertest/db";
import { Extraction, NOT_SET_UP, PlanDraft, type ConfluenceConfig, type Embedder, type StructuredModel } from "@mattertest/agent";
import { runConfluence, runIngest, runPlan, runTrack, type AgentDeps } from "../src/agent";

const hasDb = !!process.env.DATABASE_URL;
const db = hasDb ? createDb() : (undefined as never);
const brief = readFileSync(new URL("../../../packages/agent/test/fixtures/checkout-brief.md", import.meta.url));

let artefacts: string;
beforeAll(() => {
  artefacts = mkdtempSync(join(tmpdir(), "mt-agent-"));
  process.env.ARTEFACT_DIR = artefacts;
});
const created: { clientId: string; projectId: string }[] = [];
afterAll(async () => {
  if (!hasDb) return;
  for (const c of created) await removeProject(db, c.projectId, c.clientId);
  await db.$client.end();
});

/** Delete a test project and everything the agent jobs wrote for it. */
async function removeProject(d: Db, projectId: string, clientId: string) {
  await d.transaction(async (tx) => {
    await tx.delete(testPlans).where(eq(testPlans.projectId, projectId)); // cascades to scenarios and test cases
    await tx.delete(clientQuestions).where(eq(clientQuestions.projectId, projectId));
    await tx.delete(requirements).where(eq(requirements.projectId, projectId));
    await tx.delete(sources).where(eq(sources.projectId, projectId)); // cascades to chunks
    const t = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId));
    if (t.length) await tx.delete(runs).where(inArray(runs.taskId, t.map((x) => x.id)));
    await tx.delete(tasks).where(eq(tasks.projectId, projectId));
    await tx.delete(planTracks).where(eq(planTracks.projectId, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
    await tx.delete(clients).where(eq(clients.id, clientId));
  });
}

/** Answers extraction with two requirements citing real passages (found by text), and planning with one scenario per requirement. */
const model: StructuredModel = async (req) => {
  const refOf = (needle: string) => req.user.match(new RegExp(`<passage id="(c\\d+)"[^>]*>\\n[^<]*${needle}`))?.[1] ?? "c404";
  if (req.schema === (Extraction as unknown)) {
    const data = Extraction.parse({
      requirements: [
        { title: "Expired code error", text: "Expired promo codes show the expiry date and leave the total unchanged.", area: "Promo codes", acceptanceCriteria: ["Message under the field"], chunkIds: [refOf("This code expired")] },
        { title: "Free shipping over $99", text: "Standard shipping is free over $99 AUD, otherwise $9.95.", area: "Shipping", acceptanceCriteria: [], chunkIds: [refOf("Standard shipping is free")] },
      ],
      questions: [{ question: "What load time counts as fast on mobile?", why: "No target given", chunkIds: [refOf("load fast")] }],
    });
    return { data: data as never, usage: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.036 }, model: "claude-opus-5-5" };
  }
  const keys = [...req.user.matchAll(/<requirement key="(REQ-\d+)"[^>]*passages="(c\d+)/g)].map((m) => ({ key: m[1]!, ref: m[2]! }));
  const data = PlanDraft.parse({
    name: "Checkout v2 test plan",
    summary: "One-page checkout.",
    scope: ["Checkout"],
    outOfScope: ["Gateway internals"],
    risks: [{ area: "Promo codes", risk: "high", why: "Revenue", priority: "P0" }],
    criticalRequirements: [],
    stories: [{ ref: "S1", title: "Check out with a discount", actor: "guest shopper", want: "check out with the right discounts and shipping", soThat: "I pay the right price", acceptanceCriteria: ["Totals are right"], requirementKeys: keys.map((k) => k.key), priority: "P2", critical: false, criticalWhy: "" }],
    scenarios: keys.map((k) => ({
      storyRef: "S1",
      title: `Scenario for ${k.key}`,
      actor: "Guest shopper",
      situation: `Meets ${k.key} at checkout`,
      outcome: "The order goes through",
      priority: "P2",
      kind: "happy",
      requirementKeys: [k.key],
      testCases: [{ title: `Case for ${k.key}`, preconditions: "", testData: "", steps: [{ action: "Do the thing", expected: "It works" }], automationCandidate: false, chunkIds: [k.ref] }],
    })),
  });
  return { data: data as never, usage: { inputTokens: 9000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.096 }, model: "claude-opus-5-5" };
};

const embedder: Embedder = { name: "fake", dims: 1024, embed: async (texts) => texts.map((_, i) => Array.from({ length: 1024 }, (_, j) => (j === i % 1024 ? 1 : 0))) };

async function setup() {
  const [c] = await db.insert(clients).values({ name: "Northwind Outdoor", slug: `nw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  const [p] = await db.insert(projects).values({ clientId: c!.id, name: "Checkout v2", platform: "bigcommerce" }).returning();
  created.push({ clientId: c!.id, projectId: p!.id });
  return p!.id;
}

async function addSource(projectId: string, values: Partial<typeof sources.$inferInsert>) {
  const [s] = await db.insert(sources).values({ projectId, type: "md", name: "checkout-brief.md", contentHash: `h-${Math.random()}`, ...values }).returning();
  const [t] = await db.insert(tasks).values({ projectId, kind: "ingest", title: "Ingest" }).returning();
  const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
  return { sourceId: s!.id, taskId: t!.id, runId: r!.id };
}

function deps(planned: PlanJob[], f?: typeof fetch): AgentDeps {
  return { model, embedder, fetch: f, queuePlan: async (j) => void planned.push(j) };
}

describe.skipIf(!hasDb)("agent jobs", () => {
  it("ingests a document, extracts traced requirements, then drafts a plan with test cases", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "brief.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/brief.md` });
    const planned: PlanJob[] = [];

    await runIngest(db, { ...job, thenPlan: true }, deps(planned));

    const [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src!.status).toBe("ready");
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, job.sourceId)).orderBy(asc(sourceChunks.position));
    expect(chunks.length).toBeGreaterThan(5);
    expect(src!.meta.chunks).toBe(chunks.length);
    expect(chunks[0]!.embedding).toHaveLength(1024);

    const reqs = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.key));
    expect(reqs.map((r) => r.key)).toEqual(["REQ-01", "REQ-02"]);
    const cited = chunks.find((c) => c.id === reqs[0]!.sourceChunkIds[0]);
    expect(cited?.text).toContain("This code expired");
    expect(await db.select().from(clientQuestions).where(eq(clientQuestions.projectId, projectId))).toHaveLength(1);

    const [ingestRun] = await db.select().from(runs).where(eq(runs.id, job.runId));
    expect(ingestRun).toMatchObject({ status: "done", inputTokens: 5000, outputTokens: 800, costUsd: "0.0360" });

    expect(planned).toHaveLength(1);
    await runPlan(db, planned[0]!, deps([]));
    const [plan] = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId));
    expect(plan).toMatchObject({ version: 1, status: "draft", sourceIds: [job.sourceId] });
    const scen = await db.select().from(scenarios).where(eq(scenarios.planId, plan!.id)).orderBy(asc(scenarios.position));
    expect(scen.map((s) => s.requirementIds)).toEqual([["REQ-01"], ["REQ-02"]]);
    expect(scen[0]).toMatchObject({ actor: "Guest shopper", situation: "Meets REQ-01 at checkout", outcome: "The order goes through" });
    expect(plan!.body).toMatchObject({ critical: [], gaps: [] });
    const stories = await db.select().from(userStories).where(eq(userStories.planId, plan!.id));
    expect(stories.map((x) => [x.key, x.title, x.requirementIds])).toEqual([["US-01", "Check out with a discount", ["REQ-01", "REQ-02"]]]);
    expect(scen.every((x) => x.storyId === stories[0]!.id)).toBe(true);
    const cases = await db.select().from(testCases).where(inArray(testCases.scenarioId, scen.map((s) => s.id))).orderBy(asc(testCases.key));
    expect(cases.map((c) => c.key)).toEqual(["TC-001", "TC-002"]);
    expect(cases[0]!.sourceChunkIds).toEqual(reqs[0]!.sourceChunkIds);
    const [planRun] = await db.select().from(runs).where(eq(runs.id, planned[0]!.runId));
    expect(planRun!.status).toBe("done");
    expect((planRun!.summary as { testCases: number }).testCases).toBe(2);

    // Someone approves TC-001; TC-002 stays unreviewed.
    await db.update(testCases).set({ reviewState: "approved" }).where(eq(testCases.id, cases[0]!.id));

    // A new version of the same document supersedes the old one. The fresh plan continues after the reviewed case
    // (TC-001 is kept), and reuses the number of the unreviewed one; no story was reviewed, so stories restart at US-01.
    writeFileSync(join(artefacts, "sources", projectId, "brief-v2.md"), Buffer.concat([brief, Buffer.from("\n\n## 8. Extra\n\nNew rule.\n")]));
    const v2 = await addSource(projectId, { fileUri: `sources/${projectId}/brief-v2.md`, version: 2 });
    const planned2: PlanJob[] = [];
    await runIngest(db, { ...v2, thenPlan: true }, deps(planned2));
    const [old] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(old!.status).toBe("superseded");
    // The old version's open question is withdrawn; the new version asks its own.
    const qs = await db.select({ sourceId: clientQuestions.sourceId, status: clientQuestions.status }).from(clientQuestions).where(eq(clientQuestions.projectId, projectId));
    expect(qs.filter((q) => q.sourceId === job.sourceId).map((q) => q.status)).toEqual(["withdrawn"]);
    expect(qs.filter((q) => q.sourceId === v2.sourceId).map((q) => q.status)).toEqual(["open"]);
    const all = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.key));
    expect(all.map((r) => [r.key, r.reviewState])).toEqual([["REQ-01", "superseded"], ["REQ-02", "superseded"], ["REQ-03", "needs-review"], ["REQ-04", "needs-review"]]);
    await runPlan(db, planned2[0]!, deps([]));
    const plans = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId)).orderBy(asc(testPlans.version));
    expect(plans.map((p) => [p.version, p.status])).toEqual([[1, "superseded"], [2, "draft"]]);
    const newScen = await db.select().from(scenarios).where(eq(scenarios.planId, plans[1]!.id));
    const newCases = await db.select().from(testCases).where(inArray(testCases.scenarioId, newScen.map((s) => s.id))).orderBy(asc(testCases.key));
    expect(newCases.map((c) => c.key)).toEqual(["TC-002", "TC-003"]);
    // SC-001 holds the approved TC-001, so it keeps its number; the next draft's scenarios continue from SC-002.
    expect(scen.map((x) => x.key)).toEqual(["SC-001", "SC-002"]);
    expect(newScen.map((x) => x.key).sort()).toEqual(["SC-002", "SC-003"]);
    expect((await db.select({ key: userStories.key }).from(userStories).where(eq(userStories.planId, plans[1]!.id))).map((x) => x.key)).toEqual(["US-01"]);
  });

  it("starts a second test plan on the same source with its own focus, leaving the first one as it was", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "brief.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/brief.md` });
    const planned: PlanJob[] = [];
    await runIngest(db, { ...job, thenPlan: true }, deps(planned));
    const [first] = await db.select().from(planTracks).where(eq(planTracks.projectId, projectId));
    expect(first).toMatchObject({ number: 1, name: "Test plan", focus: null, sourceIds: null });
    expect(planned).toEqual([expect.objectContaining({ trackId: first!.id })]);
    await runPlan(db, planned[0]!, deps([]));
    const [planA] = await db.select().from(testPlans).where(eq(testPlans.trackId, first!.id));

    const [second] = await db.insert(planTracks).values({ projectId, number: 2, name: "Shipping", focus: "Shipping rates only", position: 1 }).returning();
    const [t] = await db.insert(tasks).values({ projectId, kind: "plan", title: "Start test plan" }).returning();
    const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
    const prompts: string[] = [];
    const spy: StructuredModel = async (req) => {
      prompts.push(req.user);
      return model(req);
    };
    const next: PlanJob[] = [];
    await runTrack(db, { taskId: t!.id, runId: r!.id, projectId, trackId: second!.id }, { ...deps(next), model: spy });
    expect(prompts[0]).toContain('<plan_focus plan="Shipping">\nShipping rates only\n</plan_focus>');
    const reqsB = await db.select().from(requirements).where(eq(requirements.trackId, second!.id)).orderBy(asc(requirements.key));
    expect(reqsB.map((x) => x.key)).toEqual(["REQ-01", "REQ-02"]); // numbered within the plan (TP2-REQ-01)
    expect(await db.select().from(clientQuestions).where(eq(clientQuestions.trackId, second!.id))).toHaveLength(1);
    expect(next).toEqual([expect.objectContaining({ trackId: second!.id })]);

    await runPlan(db, next[0]!, { ...deps([]), model: spy });
    expect(prompts.at(-1)).toContain("<plan_focus");
    expect(prompts.at(-1)).toContain('key="REQ-01"');
    expect(prompts.at(-1)).toContain('<requirements count="2">'); // only this plan's requirements
    const [planB] = await db.select().from(testPlans).where(eq(testPlans.trackId, second!.id));
    expect(planB).toMatchObject({ version: 1, status: "draft" });
    // Each plan numbers its own work from 1; the first plan's draft is untouched.
    const [stillA] = await db.select().from(testPlans).where(eq(testPlans.id, planA!.id));
    expect(stillA!.status).toBe("draft");
    expect(second!.number).toBe(2);
    const casesB = await db.select({ key: testCases.key }).from(testCases).innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId)).where(eq(scenarios.planId, planB!.id)).orderBy(asc(testCases.key));
    expect(casesB.map((c) => c.key)).toEqual(["TC-001", "TC-002"]);
    const storiesB = await db.select({ key: userStories.key }).from(userStories).where(eq(userStories.planId, planB!.id));
    expect(storiesB.map((x) => x.key)).toEqual(["US-01"]);
    const scenB = await db.select({ key: scenarios.key }).from(scenarios).where(eq(scenarios.planId, planB!.id)).orderBy(asc(scenarios.position));
    expect(scenB.map((x) => x.key)).toEqual(["SC-001", "SC-002"]);

    // Re-drafting the second plan only replaces the second plan's draft.
    const [t2] = await db.insert(tasks).values({ projectId, kind: "plan", title: "Draft" }).returning();
    const [r2] = await db.insert(runs).values({ taskId: t2!.id }).returning();
    await runPlan(db, { taskId: t2!.id, runId: r2!.id, projectId, trackId: second!.id }, deps([]));
    expect((await db.select().from(testPlans).where(eq(testPlans.id, planA!.id)))[0]!.status).toBe("draft");
    const versionsB = await db.select({ v: testPlans.version, s: testPlans.status }).from(testPlans).where(eq(testPlans.trackId, second!.id)).orderBy(asc(testPlans.version));
    expect(versionsB).toEqual([{ v: 1, s: "superseded" }, { v: 2, s: "draft" }]);

    // A new focus reads the plan afresh: requirements from sources it no longer reads go, and numbering restarts at 01.
    await db.insert(requirements).values({ projectId, trackId: second!.id, key: "REQ-03", title: "From a dropped source", text: "x" });
    await db.update(planTracks).set({ focus: "Shipping rates and delivery times" }).where(eq(planTracks.id, second!.id));
    const [t3] = await db.insert(tasks).values({ projectId, kind: "plan", title: "Read again" }).returning();
    const [r3] = await db.insert(runs).values({ taskId: t3!.id }).returning();
    const again: PlanJob[] = [];
    prompts.length = 0;
    await runTrack(db, { taskId: t3!.id, runId: r3!.id, projectId, trackId: second!.id, reset: true }, { ...deps(again), model: spy });
    expect(prompts[0]).toContain("Shipping rates and delivery times");
    const reread = await db.select({ key: requirements.key }).from(requirements).where(eq(requirements.trackId, second!.id)).orderBy(asc(requirements.key));
    expect(reread.map((x) => x.key)).toEqual(["REQ-01", "REQ-02"]);
    expect(await db.select().from(clientQuestions).where(eq(clientQuestions.trackId, second!.id))).toHaveLength(1);
    expect(again).toEqual([expect.objectContaining({ trackId: second!.id })]);
    // The first plan is untouched.
    expect((await db.select().from(requirements).where(eq(requirements.trackId, first!.id))).length).toBeGreaterThan(0);
  });

  it("parks a Loom source that has no public transcript, then reads an attached one", async () => {
    const projectId = await setup();
    const link = "https://www.loom.com/share/0123456789abcdef0123456789abcdef";
    const job = await addSource(projectId, { type: "loom", name: "Loom video 01234567", uri: link });
    const privateLoom = (async (url: string | URL | Request) =>
      String(url).includes("/graphql") ? new Response(JSON.stringify({ data: { fetchVideoTranscript: { message: "Private video" } } })) : new Response("", { status: 404 })) as typeof fetch;
    const planned: PlanJob[] = [];
    await runIngest(db, { ...job, thenPlan: true }, deps(planned, privateLoom));
    let [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src).toMatchObject({ status: "needs-transcript", error: "Loom: Private video" });
    expect((await db.select().from(runs).where(eq(runs.id, job.runId)))[0]!.status).toBe("needs-review");
    expect(planned).toHaveLength(0);

    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "t.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nThis code expired on the date shown.\n\n00:00:06.000 --> 00:00:09.000\nStandard shipping is free over $99.\n\n00:00:10.000 --> 00:00:12.000\nIt should load fast.\n");
    await db.update(sources).set({ fileUri: `sources/${projectId}/t.vtt` }).where(eq(sources.id, job.sourceId));
    const [t] = await db.insert(tasks).values({ projectId, kind: "ingest", title: "Ingest transcript" }).returning();
    const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
    await runIngest(db, { taskId: t!.id, runId: r!.id, sourceId: job.sourceId, thenPlan: true }, deps(planned, privateLoom));
    [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src!.status).toBe("ready");
    expect(src!.meta).toMatchObject({ transcriptFrom: "upload", durationSec: 12 });
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, job.sourceId));
    expect(chunks[0]!.locator).toMatchObject({ startSec: 1 });
    expect(planned).toHaveLength(1);
  });

  it("marks the run failed and keeps the cost when the model call fails", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "b.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/b.md` });
    const { AgentError } = await import("@mattertest/agent");
    const failing: StructuredModel = async () => {
      throw new AgentError("Claude declined to process this source.", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0004 });
    };
    await expect(runIngest(db, { ...job, thenPlan: true }, { model: failing, embedder: null, queuePlan: async () => {} })).rejects.toThrow(/declined/);
    const [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src).toMatchObject({ status: "failed", error: "Claude declined to process this source." });
    const [run] = await db.select().from(runs).where(eq(runs.id, job.runId));
    expect(run).toMatchObject({ status: "failed", inputTokens: 100, costUsd: "0.0004" });
  });

  describe("Confluence", () => {
    const ORIGIN = "https://northwind.atlassian.net";
    const conf: ConfluenceConfig = { origin: ORIGIN, email: "qa@matterdesign.com.au", token: "t" };
    const pages: Record<string, { title: string; version: number; html: string }> = {
      "100": { title: "Checkout v2", version: 3, html: "<h2>Promo codes</h2><p>If a code has expired, show This code expired on {date} under the field.</p><h2>Speed</h2><p>It should load fast on mobile.</p>" },
      "101": { title: "Shipping rules", version: 1, html: "<h2>Standard</h2><p>Standard shipping is free on orders over $99 (AUD).</p>" },
      "102": { title: "Old notes", version: 1, html: "<p>Nothing to test here.</p>" },
    };
    const children: Record<string, { id: string; type: string; title: string; status: string }[]> = {
      "100": [{ id: "101", type: "page", title: "Shipping rules", status: "current" }, { id: "900", type: "folder", title: "Archive", status: "current" }],
      "900": [{ id: "102", type: "page", title: "Old notes", status: "current" }],
      "800": [{ id: "100", type: "page", title: "Checkout v2", status: "current" }, { id: "101", type: "page", title: "Shipping rules", status: "current" }],
    };
    const folders: Record<string, string> = { "900": "Archive", "800": "Requirements" };
    const confluenceFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = url.pathname.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/);
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (page) {
        const p = pages[page[1]!];
        return p ? json({ id: page[1], title: p.title, version: { number: p.version }, body: { export_view: { value: p.html } }, _links: { webui: `/spaces/SHOP/pages/${page[1]}`, base: `${ORIGIN}/wiki` } }) : json({}, 404);
      }
      const kids = url.pathname.match(/^\/wiki\/api\/v2\/(?:pages|folders)\/(\d+)\/direct-children$/);
      if (kids) return json({ results: children[kids[1]!] ?? [], _links: {} });
      const folder = url.pathname.match(/^\/wiki\/api\/v2\/folders\/(\d+)$/);
      if (folder) return folders[folder[1]!] ? json({ id: folder[1], title: folders[folder[1]!] }) : json({}, 404);
      return json({}, 404);
    }) as typeof fetch;

    async function confluenceJob(projectId: string, data: { link?: string; includeChildren?: boolean; sync?: boolean }) {
      const [t] = await db.insert(tasks).values({ projectId, kind: "ingest", title: "Confluence", params: { confluence: true } }).returning();
      const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
      return { taskId: t!.id, runId: r!.id, projectId, includeChildren: false, sync: false, ...data };
    }
    const confDeps = (planned: PlanJob[], c: ConfluenceConfig | null = conf): AgentDeps => ({ ...deps(planned, confluenceFetch), confluence: c });
    const runOf = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
    const live = async (projectId: string) =>
      (await db.select().from(sources).where(eq(sources.projectId, projectId)).orderBy(asc(sources.name), asc(sources.version))).map((s) => [s.name, s.version, s.status]);

    it("adds a page with its child pages as separate sources, then drafts one plan", async () => {
      const projectId = await setup();
      const planned: PlanJob[] = [];
      const job = await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/pages/100/Checkout+v2`, includeChildren: true });
      await runConfluence(db, job, confDeps(planned));

      expect(await live(projectId)).toEqual([["Checkout v2", 1, "ready"], ["Old notes", 1, "ready"], ["Shipping rules", 1, "ready"]]);
      const [root] = await db.select().from(sources).where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ORIGIN, "100"))));
      expect(root!.meta.confluence).toEqual({ pageId: "100", version: 3, webUrl: `${ORIGIN}/wiki/spaces/SHOP/pages/100`, rootPageId: "100", includeChildren: true, rootTitle: "Checkout v2" });
      const [child] = await db.select().from(sources).where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ORIGIN, "102"))));
      expect(child!.meta.confluence).toMatchObject({ pageId: "102", rootPageId: "100" });
      expect(child!.meta.confluence?.includeChildren).toBeUndefined();

      const reqs = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.key));
      expect(reqs.map((r) => r.title).sort()).toEqual(["Expired code error", "Free shipping over $99"]);
      const run = await runOf(job.runId);
      expect(run.status).toBe("done");
      expect(run.summary).toMatchObject({ pages: 3, added: 3, changed: 0, unchanged: 0, failed: 0, requirements: 2 });
      expect(Number(run.costUsd)).toBeCloseTo(0.036 * 3, 4); // one extraction per page
      expect(planned).toHaveLength(1);
    });

    it("checks for updates: unchanged pages are skipped, a changed page gets a new version, new child pages are added", async () => {
      const projectId = await setup();
      await runConfluence(db, await confluenceJob(projectId, { link: `${ORIGIN}/wiki/pages/viewpage.action?pageId=100`, includeChildren: true }), confDeps([]));

      const quiet: PlanJob[] = [];
      const noChange = await confluenceJob(projectId, { sync: true });
      await runConfluence(db, noChange, confDeps(quiet));
      expect((await runOf(noChange.runId)).summary).toMatchObject({ pages: 3, added: 0, changed: 0, unchanged: 3 });
      expect(quiet).toHaveLength(0);

      // The team removes "Old notes"; a later change to it in Confluence doesn't bring it back.
      await db.update(sources).set({ status: "removed" }).where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ORIGIN, "102"))));
      pages["102"]!.version = 2;
      const saved = { ...pages["101"]! };
      pages["101"] = { ...saved, version: 2, html: saved.html + "<p>Express shipping costs $14.95.</p>" };
      children["900"]!.push({ id: "103", type: "page", title: "New page", status: "current" });
      pages["103"] = { title: "New page", version: 1, html: "<p>Standard shipping is free on orders over $99 for members too.</p>" };
      try {
        const planned: PlanJob[] = [];
        const sync = await confluenceJob(projectId, { sync: true });
        await runConfluence(db, sync, confDeps(planned));
        expect((await runOf(sync.runId)).summary).toMatchObject({ pages: 4, added: 1, changed: 1, unchanged: 2 });
        expect(await live(projectId)).toEqual([["Checkout v2", 1, "ready"], ["New page", 1, "ready"], ["Old notes", 1, "removed"], ["Shipping rules", 1, "superseded"], ["Shipping rules", 2, "ready"]]);
        const states = await db.select({ key: requirements.key, state: requirements.reviewState, sourceId: requirements.sourceId }).from(requirements).where(eq(requirements.projectId, projectId));
        expect(states.filter((r) => r.state === "superseded")).toHaveLength(1);
        expect(planned).toHaveLength(1);
      } finally {
        pages["101"] = saved;
        pages["102"]!.version = 1;
        children["900"]!.pop();
        delete pages["103"];
      }
    });

    it("adds a folder: every page in it, including one the team had removed, and update checks read the folder again", async () => {
      const projectId = await setup();
      await runConfluence(db, await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/pages/100` }), confDeps([]));
      await db.update(sources).set({ status: "removed" }).where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ORIGIN, "100"))));

      const planned: PlanJob[] = [];
      const job = await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/folder/800`, includeChildren: true });
      await runConfluence(db, job, confDeps(planned));
      expect((await runOf(job.runId)).summary).toMatchObject({ pages: 3, added: 3, changed: 0, failed: 0 }); // page 100's own child pages come too
      expect(await live(projectId)).toEqual([["Checkout v2", 1, "superseded"], ["Checkout v2", 2, "ready"], ["Old notes", 1, "ready"], ["Shipping rules", 1, "ready"]]);
      const [readded] = await db.select().from(sources).where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ORIGIN, "100")), eq(sources.version, 2)));
      expect(readded!.meta.confluence).toMatchObject({ pageId: "100", rootPageId: "800", rootKind: "folder" });
      expect(planned).toHaveLength(1);

      const sync = await confluenceJob(projectId, { sync: true });
      await runConfluence(db, sync, confDeps([]));
      expect((await runOf(sync.runId)).summary).toMatchObject({ pages: 3, added: 0, changed: 0, unchanged: 3 });

      const empty = await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/folder/900` });
      children["900"]!.length = 0;
      try {
        await runConfluence(db, empty, confDeps([]));
      } finally {
        children["900"]!.push({ id: "102", type: "page", title: "Old notes", status: "current" });
      }
      expect(await runOf(empty.runId)).toMatchObject({ status: "failed", summary: { error: 'The folder "Archive" has no pages in it.' } });
    });

    it("fails the run with a plain message when Confluence isn't set up or can't open the page", async () => {
      const projectId = await setup();
      const noCfg = await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/pages/100` });
      await runConfluence(db, noCfg, confDeps([], null));
      expect(await runOf(noCfg.runId)).toMatchObject({ status: "failed", summary: { error: NOT_SET_UP } });

      const missing = await confluenceJob(projectId, { link: `${ORIGIN}/wiki/spaces/SHOP/pages/404` });
      await runConfluence(db, missing, confDeps([]));
      const run = await runOf(missing.runId);
      expect(run.status).toBe("failed");
      expect((run.summary as { error: string }).error).toMatch(/Couldn't open page 404/);
      expect(await live(projectId)).toEqual([]);
    });
  });

  it("gives Claude the QA guidelines, the project's instructions and the source's note, and records them on the runs", async () => {
    const projectId = await setup();
    await db.update(projects).set({ agentInstructions: "Focus on promo codes. Treat payments as P0." }).where(eq(projects.id, projectId));
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "n.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/n.md`, meta: { note: "Version 1.2, signed off by the client." } });
    const seen: string[] = [];
    const guides: (string | null | undefined)[] = [];
    const spy: StructuredModel = async (req) => {
      seen.push(req.user);
      guides.push(req.guidelines);
      return model(req);
    };
    const planned: PlanJob[] = [];
    const guide = async () => ({ text: "- P0 means money or bookings.", version: "abc123def456", path: "qa.md" });
    await runIngest(db, { ...job, thenPlan: true }, { model: spy, embedder: null, guidelines: guide, queuePlan: async (j) => void planned.push(j) });
    await runPlan(db, planned[0]!, { model: spy, embedder: null, guidelines: guide, queuePlan: async () => {} });

    expect(seen).toHaveLength(2);
    expect(guides).toEqual(["- P0 means money or bookings.", "- P0 means money or bookings."]);
    for (const u of seen) expect(u).toContain("<team_instructions>\nFocus on promo codes. Treat payments as P0.\n</team_instructions>");
    expect(seen[0]).toContain("<source_note>\nVersion 1.2, signed off by the client.\n</source_note>");
    expect(seen[1]).toContain("- checkout-brief.md: Version 1.2, signed off by the client.");
    const [ingest] = await db.select().from(runs).where(eq(runs.id, job.runId));
    expect(ingest!.summary).toMatchObject({ instructions: "Focus on promo codes. Treat payments as P0.", sourceNote: "Version 1.2, signed off by the client.", guidelinesVersion: "abc123def456" });
    const [plan] = await db.select().from(runs).where(eq(runs.id, planned[0]!.runId));
    expect(plan!.summary).toMatchObject({ instructions: "Focus on promo codes. Treat payments as P0.", guidelinesVersion: "abc123def456" });
  });

  it("saves scenarios story by story, so test case numbers run in story order", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "o.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/o.md` });
    const planned: PlanJob[] = [];
    await runIngest(db, { ...job, thenPlan: true }, deps(planned));
    // Claude lists S2's scenario first (as a gap-filled scenario would arrive last for its story).
    const outOfOrder: StructuredModel = async (req) => {
      if (req.schema !== (PlanDraft as unknown)) return model(req);
      const keys = [...req.user.matchAll(/<requirement key="(REQ-\d+)"[^>]*passages="(c\d+)/g)].map((m) => ({ key: m[1]!, ref: m[2]! }));
      const story = (ref: string, key: string) => ({ ref, title: `Story ${ref}`, actor: "shopper", want: "w", soThat: "s", acceptanceCriteria: [], requirementKeys: [key], priority: "P2", critical: false, criticalWhy: "" });
      const scen = (ref: string, k: { key: string; ref: string }) => ({ storyRef: ref, title: `For ${ref}`, actor: "a", situation: "s", outcome: "o", priority: "P2", kind: "happy", requirementKeys: [k.key], testCases: [{ title: `Case ${ref}`, preconditions: "", testData: "", steps: [{ action: "a", expected: "e" }], automationCandidate: false, chunkIds: [k.ref] }] });
      const data = PlanDraft.parse({ name: "p", summary: "s", scope: [], outOfScope: [], risks: [], criticalRequirements: [], stories: [story("S1", keys[0]!.key), story("S2", keys[1]!.key)], scenarios: [scen("S2", keys[1]!), scen("S1", keys[0]!)] });
      return { data: data as never, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, model: "claude-opus-5-5" };
    };
    await runPlan(db, planned[0]!, { model: outOfOrder, embedder: null, queuePlan: async () => {} });
    const [plan] = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId));
    const scen = await db.select().from(scenarios).where(eq(scenarios.planId, plan!.id)).orderBy(asc(scenarios.position));
    expect(scen.map((x) => [x.key, x.title])).toEqual([["SC-001", "For S1"], ["SC-002", "For S2"]]);
    const cases = await db.select().from(testCases).where(inArray(testCases.scenarioId, scen.map((x) => x.id))).orderBy(asc(testCases.key));
    expect(cases.map((c) => [c.key, c.title])).toEqual([["TC-001", "Case S1"], ["TC-002", "Case S2"]]);
  });

  it("keeps approved stories and test cases through a re-draft, and tells Claude not to redraft them", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "k.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/k.md` });
    const planned: PlanJob[] = [];
    await runIngest(db, { ...job, thenPlan: true }, deps(planned));
    await runPlan(db, planned[0]!, deps([]));
    const [v1] = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId));
    const [story] = await db.select().from(userStories).where(eq(userStories.planId, v1!.id));
    const v1Scen = await db.select().from(scenarios).where(eq(scenarios.planId, v1!.id)).orderBy(asc(scenarios.position));
    const [approvedCase] = await db.select().from(testCases).where(eq(testCases.scenarioId, v1Scen[0]!.id));
    await db.update(userStories).set({ reviewState: "approved", reviewedBy: "qa@matterdesign.com.au" }).where(eq(userStories.id, story!.id));
    await db.update(testCases).set({ reviewState: "approved" }).where(eq(testCases.id, approvedCase!.id));

    // Re-draft: the model sees the approved work and drafts only REQ-02's scenario (REQ-01 is covered by the kept one).
    const seen: string[] = [];
    const redraft: StructuredModel = async (req) => {
      seen.push(req.user);
      if (req.schema !== (PlanDraft as unknown)) return model(req);
      const ref = req.user.match(/<requirement key="REQ-02"[^>]*passages="(c\d+)/)![1]!;
      const data = PlanDraft.parse({
        name: "v2", summary: "s", scope: [], outOfScope: [], risks: [], criticalRequirements: [], stories: [],
        scenarios: [{ storyRef: "A1", title: "New for REQ-02", actor: "a", situation: "s", outcome: "o", priority: "P2", kind: "happy", requirementKeys: ["REQ-02"], testCases: [{ title: "New case", preconditions: "", testData: "", steps: [{ action: "a", expected: "e" }], automationCandidate: false, chunkIds: [ref] }] }],
      });
      return { data: data as never, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, model: "claude-opus-5-5" };
    };
    const [t] = await db.insert(tasks).values({ projectId, kind: "plan", title: "Draft test plan" }).returning();
    const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
    await runPlan(db, { taskId: t!.id, runId: r!.id, projectId }, { model: redraft, embedder: null, queuePlan: async () => {} });

    expect(seen[0]).toContain("Already approved by the team");
    expect(seen[0]).toContain(`- A1 (${story!.key}): ${story!.title}.`);
    expect(seen[0]).toContain(`${approvedCase!.key} ${approvedCase!.title}`);
    expect(seen).toHaveLength(1); // the kept scenario already covers REQ-01, so no follow-up call
    const [v2] = await db.select().from(testPlans).where(and(eq(testPlans.projectId, projectId), eq(testPlans.status, "draft")));
    const v2Stories = await db.select().from(userStories).where(eq(userStories.planId, v2!.id));
    expect(v2Stories.map((x) => [x.key, x.reviewState, x.reviewedBy])).toEqual([[story!.key, "approved", "qa@matterdesign.com.au"]]);
    const v2Scen = await db.select().from(scenarios).where(eq(scenarios.planId, v2!.id)).orderBy(asc(scenarios.position));
    expect(v2Scen.map((x) => [x.key, x.title, x.storyId])).toEqual([
      [v1Scen[0]!.key, v1Scen[0]!.title, v2Stories[0]!.id],
      ["SC-002", "New for REQ-02", v2Stories[0]!.id],
    ]);
    // The approved case moved across: same row, same number, still approved.
    const [moved] = await db.select().from(testCases).where(eq(testCases.id, approvedCase!.id));
    expect(moved).toMatchObject({ scenarioId: v2Scen[0]!.id, key: approvedCase!.key, reviewState: "approved" });
    const fresh = await db.select().from(testCases).where(eq(testCases.scenarioId, v2Scen[1]!.id));
    expect(fresh.map((c) => c.key)).toEqual(["TC-002"]);
    const [run] = await db.select().from(runs).where(eq(runs.id, r!.id));
    expect(run!.summary).toMatchObject({ kept: { stories: 1, scenarios: 1, testCases: 1 } });
  });
});
