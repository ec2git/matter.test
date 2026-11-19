/** Sending a test plan to Jira, against a real database with Jira faked. Needs a migrated Postgres at DATABASE_URL; skipped otherwise. */
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { clients, createDb, planTracks, projects, requirements, runs, scenarios, tasks, testCases, testPlans, userStories } from "@mattertest/db";
import type { JiraConfig } from "@mattertest/agent";
import { runJiraExport } from "../src/jira";

const hasDb = !!process.env.DATABASE_URL;
const db = hasDb ? createDb() : (undefined as never);
const cfg: JiraConfig = { origin: "https://example.atlassian.net", email: "qa@example.com", token: "t" };
const made: { clientId: string; projectId: string }[] = [];

afterAll(async () => {
  if (!hasDb) return;
  for (const { clientId, projectId } of made) {
    await db.delete(testPlans).where(eq(testPlans.projectId, projectId));
    await db.delete(requirements).where(eq(requirements.projectId, projectId));
    const t = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId));
    if (t.length) await db.delete(runs).where(inArray(runs.taskId, t.map((x) => x.id)));
    await db.delete(tasks).where(eq(tasks.projectId, projectId));
    await db.delete(planTracks).where(eq(planTracks.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(clients).where(eq(clients.id, clientId));
  }
  await db.$client.end();
});

type Call = { method: string; path: string; body: any };

/** A Jira with one project (DEMO): Epic, Task and the site's priorities. Issues it "has" are in `issues`. */
function fakeJira() {
  const calls: Call[] = [];
  const issues = new Set<string>();
  let next = 100;
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname;
    calls.push({ method, path: path + u.search, body });
    if (path === "/rest/api/3/project/DEMO") return json(200, { key: "DEMO", name: "Demo client" });
    if (path === "/rest/api/3/issue/createmeta/DEMO/issuetypes")
      return json(200, { issueTypes: [{ id: "1", name: "Bug" }, { id: "10000", name: "Epic" }, { id: "3", name: "Task" }, { id: "5", name: "Sub-task", subtask: true }] });
    if (path === "/rest/api/3/issue/createmeta/DEMO/issuetypes/3")
      return json(200, { fields: [{ fieldId: "priority", allowedValues: ["Blocker", "Critical", "Major", "Minor", "Trivial"].map((name, i) => ({ id: String(i + 1), name })) }] });
    if (method === "POST" && path === "/rest/api/3/issue") {
      const key = `DEMO-${next++}`;
      issues.add(key);
      return json(201, { key });
    }
    if (method === "POST" && path === "/rest/api/3/issue/bulk") {
      const out = body.issueUpdates.map(() => {
        const key = `DEMO-${next++}`;
        issues.add(key);
        return { key };
      });
      return json(201, { issues: out, errors: [] });
    }
    const put = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
    if (method === "PUT" && put) return issues.has(put[1]!) ? json(204, null) : json(404, { errorMessages: ["Issue does not exist"] });
    return json(404, { errorMessages: [`no route ${method} ${path}`] });
  }) as typeof fetch;
  return { f, calls, issues };
}

async function setup() {
  const [c] = await db.insert(clients).values({ name: "Jira test", slug: `jira-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  const [p] = await db.insert(projects).values({ clientId: c!.id, name: "Bookings", platform: "shopify" }).returning();
  made.push({ clientId: c!.id, projectId: p!.id });
  const [track] = await db.insert(planTracks).values({ projectId: p!.id, number: 2, name: "Bookings", focus: "Fitting bookings" }).returning();
  await db.insert(requirements).values({ projectId: p!.id, trackId: track!.id, key: "REQ-01", title: "Guests can book", text: "Guests can book a fitting." });
  const [plan] = await db
    .insert(testPlans)
    .values({ projectId: p!.id, trackId: track!.id, name: "Bookings", version: 3, status: "approved", body: { summary: "Fitting bookings.", scope: ["Booking"], outOfScope: [], risks: [{ area: "Booking", risk: "high", why: "Lost fittings", priority: "P0" }] } })
    .returning();
  const [story] = await db.insert(userStories).values({ planId: plan!.id, key: "US-01", title: "Book a fitting", actor: "a guest", want: "book a fitting", soThat: "I get the right size", priority: "P0" }).returning();
  const [scen] = await db.insert(scenarios).values({ planId: plan!.id, key: "SC-001", title: "Guest books", priority: "P0", kind: "happy", storyId: story!.id, requirementIds: ["REQ-01"] }).returning();
  const steps = [{ action: "Open booking\nPick a time", expected: "Slots show" }];
  const cases = await db
    .insert(testCases)
    .values([
      { scenarioId: scen!.id, key: "TC-001", title: "Book as guest", steps, reviewState: "approved" },
      { scenarioId: scen!.id, key: "TC-002", title: "Book with no slots", steps, reviewState: "approved", preconditions: "No slots this week" },
      { scenarioId: scen!.id, key: "TC-003", title: "Not reviewed yet", steps },
    ])
    .returning();
  const job = async () => {
    const [t] = await db.insert(tasks).values({ projectId: p!.id, kind: "export", title: "Send to Jira" }).returning();
    const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
    return { taskId: t!.id, runId: r!.id, projectId: p!.id, trackId: track!.id, jiraProject: "DEMO" };
  };
  return { trackId: track!.id, cases, job };
}

describe.skipIf(!hasDb)("Jira export", () => {
  it("sends an Epic and a Task per approved test case, then updates them when sent again", async () => {
    const { trackId, cases, job } = await setup();
    const jira = fakeJira();

    const first = await job();
    const r1 = await runJiraExport(db, first, { jira: cfg, fetch: jira.f, appUrl: "http://mt.test" });
    expect(r1).toMatchObject({ jiraProject: "DEMO", epicKey: "DEMO-100", created: 3, updated: 0, failed: 0, testCases: 2 });

    const epic = jira.calls.find((c) => c.method === "POST" && c.path === "/rest/api/3/issue")!;
    expect(epic.body.fields).toMatchObject({ project: { key: "DEMO" }, issuetype: { id: "10000" }, summary: "TP02 Bookings: test plan", labels: ["mattertest", "TP02"] });
    const bulk = jira.calls.find((c) => c.path === "/rest/api/3/issue/bulk")!;
    expect(bulk.body.issueUpdates).toHaveLength(2); // the unreviewed case stays out
    const task = bulk.body.issueUpdates[0].fields;
    expect(task).toMatchObject({ issuetype: { id: "3" }, summary: "TP02-TC-001 Book as guest", parent: { key: "DEMO-100" }, priority: { id: "2" } }); // P0 → Critical
    const text = JSON.stringify(task.description);
    expect(text).toContain("TP02-US-01");
    expect(text).toContain("TP02-REQ-01 Guests can book");
    expect(text).toContain('"hardBreak"'); // line breaks in a step survive
    expect(text).toContain(`http://mt.test/projects/${first.projectId}/review?item=tc:${cases[0]!.id}&plan=${trackId}`);

    const saved = await db.select().from(testCases).where(inArray(testCases.id, cases.map((c) => c.id)));
    expect(saved.find((c) => c.key === "TC-001")!.jiraIssueKey).toBe("DEMO-101");
    expect(saved.find((c) => c.key === "TC-003")!.jiraIssueKey).toBeNull();
    const [t1] = await db.select().from(planTracks).where(eq(planTracks.id, trackId));
    expect(t1!.jiraEpicKey).toBe("DEMO-100");
    expect(t1!.jiraSentAt).not.toBeNull();
    const [run1] = await db.select().from(runs).where(eq(runs.id, first.runId));
    expect(run1!.status).toBe("done");
    expect(Number(run1!.costUsd)).toBe(0);

    // Someone deleted TC-002's Task in Jira, and TC-003 was approved since.
    jira.issues.delete("DEMO-102");
    await db.update(testCases).set({ reviewState: "approved" }).where(eq(testCases.id, cases[2]!.id));
    jira.calls.length = 0;
    const r2 = await runJiraExport(db, await job(), { jira: cfg, fetch: jira.f, appUrl: "http://mt.test" });
    expect(r2).toMatchObject({ epicKey: "DEMO-100", created: 2, updated: 2, failed: 0, testCases: 3 });
    const puts = jira.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path.split("?")[0])).toEqual(["/rest/api/3/issue/DEMO-100", "/rest/api/3/issue/DEMO-101", "/rest/api/3/issue/DEMO-102"]);
    expect(puts[1]!.body.update.labels).toEqual([{ add: "mattertest" }, { add: "TP02" }]); // labels added, never replaced
    const again = jira.calls.find((c) => c.path === "/rest/api/3/issue/bulk")!;
    expect(again.body.issueUpdates.map((u: any) => u.fields.summary)).toEqual(["TP02-TC-002 Book with no slots", "TP02-TC-003 Not reviewed yet"]);
  });

  it("starts afresh in another Jira project, and fails clearly when nothing is approved", async () => {
    const { trackId, cases, job } = await setup();
    await db.update(planTracks).set({ jiraEpicKey: "OTHER-9" }).where(eq(planTracks.id, trackId));
    await db.update(testCases).set({ jiraIssueKey: "OTHER-10" }).where(eq(testCases.id, cases[0]!.id));
    const jira = fakeJira();
    const r = await runJiraExport(db, await job(), { jira: cfg, fetch: jira.f });
    expect(r).toMatchObject({ epicKey: "DEMO-100", created: 3, updated: 0 });
    expect(jira.calls.some((c) => c.method === "PUT")).toBe(false);

    await db.update(testCases).set({ reviewState: "needs-review" }).where(inArray(testCases.id, cases.map((c) => c.id)));
    const none = await job();
    await expect(runJiraExport(db, none, { jira: cfg, fetch: jira.f })).rejects.toThrow(/No test cases in this plan are approved/);
    const [run] = await db.select().from(runs).where(eq(runs.id, none.runId));
    expect(run!.status).toBe("failed");

    const off = await job();
    await expect(runJiraExport(db, off, { jira: null })).rejects.toThrow(/Jira isn't set up/);
  });
});
