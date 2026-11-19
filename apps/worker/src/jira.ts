import { and, asc, desc, eq, ne } from "drizzle-orm";
import { planCode, planKey, type JiraExportJob } from "@mattertest/core";
import { type Db, planTracks, requirements, scenarios, testCases, testPlans, userStories } from "@mattertest/db";
import {
  JIRA_NOT_SET_UP,
  JiraError,
  NO_USAGE,
  caseDescription,
  createIssue,
  createIssues,
  jiraIssueUrl,
  jiraProjectMeta,
  planDescription,
  updateIssue,
  type JiraConfig,
  type JiraIssueInput,
} from "@mattertest/agent";
import { finish, progress, start } from "./agent";

export type JiraDeps = { jira: JiraConfig | null; fetch?: typeof fetch; appUrl?: string; log?: (msg: string) => void };

/** Scenario priority to the Jira priorities this site uses (Blocker is left for real blockers). */
const PRIORITY: Record<string, string[]> = { P0: ["critical", "highest"], P1: ["major", "high"], P2: ["minor", "medium"], P3: ["trivial", "low", "lowest"] };

/** Is this issue in that Jira project (DEBRA-12 in DEBRA)? A plan sent to another project starts afresh there. */
const inProject = (key: string | null | undefined, project: string): key is string => !!key && key.startsWith(`${project}-`);

/**
 * Send a test plan's approved test cases to Jira: an Epic for the plan, a Task under it for each case. Sending again
 * updates the same issues (summary, description, priority; labels are added) and creates Tasks for newly approved
 * cases. Nothing is deleted or moved between statuses in Jira.
 */
export async function runJiraExport(db: Db, job: JiraExportJob, deps: JiraDeps) {
  const log = deps.log ?? (() => {});
  const f = deps.fetch ?? fetch;
  const appUrl = (deps.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  await start(db, job.taskId, job.runId);
  const counts = { created: 0, updated: 0, failed: 0, skipped: 0 };
  const problems: string[] = [];
  try {
    const cfg = deps.jira;
    if (!cfg) throw new JiraError(JIRA_NOT_SET_UP);
    const [track] = await db.select().from(planTracks).where(and(eq(planTracks.id, job.trackId), eq(planTracks.projectId, job.projectId)));
    if (!track) throw new Error("That test plan no longer exists.");
    const [plan] = await db
      .select()
      .from(testPlans)
      .where(and(eq(testPlans.trackId, track.id), ne(testPlans.status, "superseded")))
      .orderBy(desc(testPlans.version))
      .limit(1);
    if (!plan) throw new Error("This test plan hasn't been drafted yet.");

    const rows = await db
      .select({ c: testCases, s: scenarios, st: userStories })
      .from(testCases)
      .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
      .leftJoin(userStories, eq(userStories.id, scenarios.storyId))
      .where(and(eq(scenarios.planId, plan.id), eq(testCases.reviewState, "approved")))
      .orderBy(asc(scenarios.position), asc(testCases.key));
    if (!rows.length) throw new Error("No test cases in this plan are approved yet. Approve some in Review, then send again.");
    const reqTitles = new Map((await db.select({ key: requirements.key, title: requirements.title }).from(requirements).where(eq(requirements.trackId, track.id))).map((r) => [r.key, r.title]));

    const meta = await jiraProjectMeta(cfg, job.jiraProject, f);
    log(`sending ${rows.length} test cases to ${meta.key} (${meta.name})`);
    const code = planCode(track.number);
    const K = (key: string) => planKey(track.number, key);
    const labels = ["mattertest", code];
    const total = rows.length + 1;
    const step = (done: number) => progress(db, job.runId, { label: `Sending to Jira ${meta.key}`, done, total, stepWeight: 1, expectSec: 2 });
    const priorityId = (p: string) => (PRIORITY[p] ?? []).map((n) => meta.priorities.get(n)).find(Boolean);
    await step(0);

    // The Epic: updated if this plan was sent to this project before and it's still there, created otherwise.
    const planUrl = `${appUrl}/projects/${job.projectId}/assets?plan=${track.id}`;
    const epic: JiraIssueInput = {
      summary: `${code} ${track.name}: test plan`,
      description: planDescription({
        code,
        name: track.name,
        version: plan.version,
        focus: track.focus,
        summary: plan.body?.summary,
        scope: plan.body?.scope ?? [],
        outOfScope: plan.body?.outOfScope ?? [],
        risks: plan.body?.risks ?? [],
        url: planUrl,
      }),
      labels,
      priorityId: undefined,
    };
    const epicTypeId = meta.epicTypeId ?? meta.taskTypeId;
    let epicKey = inProject(track.jiraEpicKey, meta.key) && (await updateIssue(cfg, track.jiraEpicKey, epic, f)) ? track.jiraEpicKey : null;
    if (epicKey) counts.updated++;
    else {
      epicKey = await createIssue(cfg, meta.key, epicTypeId, epic, f);
      counts.created++;
    }
    await db.update(planTracks).set({ jiraEpicKey: epicKey, jiraSentAt: new Date() }).where(eq(planTracks.id, track.id));
    log(`epic ${epicKey}`);
    await step(1);

    // The test cases: one Task each, under the Epic (only when it really is an Epic).
    const parentKey = meta.epicTypeId ? epicKey : undefined;
    const issueOf = ({ c, s, st }: (typeof rows)[number]): JiraIssueInput => ({
      summary: `${K(c.key)} ${c.title}`,
      description: caseDescription({
        code: K(c.key),
        title: c.title,
        priority: s.priority,
        kind: s.kind,
        preconditions: c.preconditions,
        testData: c.testData,
        steps: c.steps,
        automationCandidate: c.automationCandidate,
        story: st ? { code: K(st.key), title: st.title, actor: st.actor, want: st.want, soThat: st.soThat } : null,
        scenario: { code: s.key ? K(s.key) : null, title: s.title, actor: s.actor, situation: s.situation, outcome: s.outcome },
        requirements: s.requirementIds.map((r) => ({ code: K(r), title: reqTitles.get(r) ?? "" })),
        url: `${appUrl}/projects/${job.projectId}/review?item=tc:${c.id}&plan=${track.id}`,
      }),
      labels,
      priorityId: priorityId(s.priority),
      parentKey,
    });

    let done = 1;
    const toCreate: (typeof rows)[number][] = [];
    for (const row of rows) {
      if (inProject(row.c.jiraIssueKey, meta.key) && (await updateIssue(cfg, row.c.jiraIssueKey, issueOf(row), f))) {
        counts.updated++;
        await step(++done);
      } else toCreate.push(row);
    }
    if (toCreate.length) {
      const results = await createIssues(cfg, meta.key, meta.taskTypeId, toCreate.map(issueOf), f, (n) => step(done + n));
      for (const [i, r] of results.entries()) {
        const row = toCreate[i]!;
        if ("key" in r) {
          counts.created++;
          await db.update(testCases).set({ jiraIssueKey: r.key }).where(eq(testCases.id, row.c.id));
        } else {
          counts.failed++;
          if (problems.length < 10) problems.push(`${K(row.c.key)}: ${r.error}`);
        }
      }
    }
    await db.update(planTracks).set({ jiraSentAt: new Date() }).where(eq(planTracks.id, track.id));
    const summary = { jiraProject: meta.key, epicKey, epicUrl: jiraIssueUrl(cfg.origin, epicKey), planVersion: plan.version, ...counts, testCases: rows.length, ...(problems.length ? { problems } : {}) };
    log(`done: ${counts.created} created, ${counts.updated} updated, ${counts.failed} failed`);
    await finish(db, job.taskId, job.runId, counts.failed && !counts.created && !counts.updated ? "failed" : "done", NO_USAGE, {
      ...summary,
      ...(counts.failed ? { error: `${counts.failed} of ${rows.length} test cases didn't go to Jira. ${problems[0] ?? ""}`.trim() } : {}),
    });
    return summary;
  } catch (e) {
    const error = e instanceof JiraError || e instanceof Error ? e.message : String(e);
    await finish(db, job.taskId, job.runId, "failed", NO_USAGE, { error, jiraProject: job.jiraProject, ...counts });
    throw e;
  }
}
