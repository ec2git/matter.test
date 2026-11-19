/**
 * Jira Cloud, through the REST API v3 with one account's API token (basic auth): just enough to send a test plan
 * as an Epic with a Task per test case, and to update them when the plan is sent again.
 * https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
export type JiraConfig = { origin: string; email: string; token: string };

/** A Jira failure worded for the Agent runs list. */
export class JiraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraError";
  }
}

export const JIRA_NOT_SET_UP = "Jira isn't set up on the worker: put JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (or the CONFLUENCE_* values) in .env and restart the worker.";

/**
 * Connection settings from the environment. JIRA_* wins; the CONFLUENCE_* settings are used otherwise, since one
 * Atlassian API token works for both products on the same site.
 */
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig | null {
  const base = env.JIRA_BASE_URL || env.CONFLUENCE_BASE_URL;
  const email = env.JIRA_EMAIL || env.CONFLUENCE_EMAIL;
  const token = env.JIRA_API_TOKEN || env.CONFLUENCE_API_TOKEN;
  if (!base || !email || !token) return null;
  try {
    return { origin: new URL(base).origin, email, token };
  } catch {
    return null;
  }
}

export const jiraIssueUrl = (origin: string, key: string) => `${origin}/browse/${key}`;

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Jira's own words for a rejected request ("Field 'priority' cannot be set…"), if it gave any. */
function jiraMessage(body: unknown): string {
  const b = body as { errorMessages?: string[]; errors?: Record<string, string> } | null;
  return [...(b?.errorMessages ?? []), ...Object.entries(b?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ");
}

/** One request; null for a 404 when `missingOk`. Waits and retries when Jira's rate limit is hit. */
async function call<T>(cfg: JiraConfig, f: Fetch, method: string, path: string, what: string, body?: unknown, missingOk = false): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(`${cfg.origin}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new JiraError(`Couldn't reach Jira at ${cfg.origin}. Check the worker's network connection.`);
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? 0);
      await sleep(Math.min(30, wait > 0 ? wait : 2 ** attempt * 2) * 1000);
      continue;
    }
    if (res.status === 404 && missingOk) return null;
    if (res.status === 204) return {} as T;
    const json = await res.json().catch(() => null);
    if (res.ok) return json as T;
    if (res.status === 401) throw new JiraError("Jira rejected the API token. Check JIRA_EMAIL and JIRA_API_TOKEN (or the CONFLUENCE_* values) in .env.");
    if (res.status === 403 || res.status === 404)
      throw new JiraError(`Couldn't open ${what}: it doesn't exist, or the MatterTest Jira account (${cfg.email}) can't see it.`);
    if (res.status === 429) throw new JiraError("Jira's rate limit was hit. Try again in a minute.");
    const detail = jiraMessage(json);
    throw new JiraError(`Jira refused ${what} (${res.status})${detail ? `: ${detail}` : "."}`);
  }
}

/** What a Jira project offers for an export: its Epic and Task issue types and its priorities by name. */
export type JiraProjectMeta = { key: string; name: string; epicTypeId: string | null; taskTypeId: string; priorities: Map<string, string> };

export async function jiraProjectMeta(cfg: JiraConfig, projectKey: string, f: Fetch = fetch): Promise<JiraProjectMeta> {
  const what = `Jira project ${projectKey}`;
  const project = (await call<{ key: string; name: string }>(cfg, f, "GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}`, what))!;
  const types = (await call<{ issueTypes?: { id: string; name: string; subtask?: boolean }[] }>(cfg, f, "GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`, what))!;
  const list = (types.issueTypes ?? []).filter((t) => !t.subtask);
  const task = list.find((t) => t.name === "Task") ?? list.find((t) => t.name !== "Epic" && t.name !== "Bug");
  if (!task) throw new JiraError(`${what} has no Task issue type to put test cases in.`);
  const epic = list.find((t) => t.name === "Epic") ?? null;
  const fields = (await call<{ fields?: { fieldId: string; allowedValues?: { id: string; name: string }[] }[] }>(
    cfg,
    f,
    "GET",
    `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${task.id}?maxResults=200`,
    what,
  ))!;
  const priorityField = (fields.fields ?? []).find((x) => x.fieldId === "priority");
  const priorities = new Map((priorityField?.allowedValues ?? []).map((v) => [v.name.toLowerCase(), v.id]));
  return { key: project.key, name: project.name, epicTypeId: epic?.id ?? null, taskTypeId: task.id, priorities };
}

/** Fields for a new or updated issue. Labels are only ever added, so ones the team adds in Jira stay. */
export type JiraIssueInput = { summary: string; description: AdfDoc; labels: string[]; priorityId?: string; parentKey?: string };

const MAX_SUMMARY = 250;
const clip = (s: string) => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s);

function createFields(projectKey: string, typeId: string, x: JiraIssueInput) {
  return {
    project: { key: projectKey },
    issuetype: { id: typeId },
    summary: clip(x.summary),
    description: x.description,
    labels: x.labels,
    ...(x.priorityId ? { priority: { id: x.priorityId } } : {}),
    ...(x.parentKey ? { parent: { key: x.parentKey } } : {}),
  };
}

/** Create issues, 50 to a request. Returns each one's key, or its error, in the order given. */
export async function createIssues(
  cfg: JiraConfig,
  projectKey: string,
  typeId: string,
  issues: JiraIssueInput[],
  f: Fetch = fetch,
  onBatch?: (done: number) => Promise<void>,
): Promise<({ key: string } | { error: string })[]> {
  const out: ({ key: string } | { error: string })[] = [];
  for (let i = 0; i < issues.length; i += 50) {
    const batch = issues.slice(i, i + 50);
    const res = (await call<{ issues?: { key: string }[]; errors?: { failedElementNumber: number; elementErrors?: unknown }[] }>(
      cfg,
      f,
      "POST",
      "/rest/api/3/issue/bulk",
      `new issues in ${projectKey}`,
      { issueUpdates: batch.map((x) => ({ fields: createFields(projectKey, typeId, x) })) },
    ))!;
    const failed = new Map((res.errors ?? []).map((e) => [e.failedElementNumber, jiraMessage(e.elementErrors) || "Jira refused it"]));
    const created = [...(res.issues ?? [])];
    for (let j = 0; j < batch.length; j++) {
      const err = failed.get(j);
      const ok = err === undefined ? created.shift() : undefined;
      out.push(ok ? { key: ok.key } : { error: err ?? "Jira didn't say" });
    }
    await onBatch?.(out.length);
  }
  return out;
}

/** Create one issue (the plan's Epic). */
export async function createIssue(cfg: JiraConfig, projectKey: string, typeId: string, x: JiraIssueInput, f: Fetch = fetch): Promise<string> {
  const res = (await call<{ key: string }>(cfg, f, "POST", "/rest/api/3/issue", `a new issue in ${projectKey}`, { fields: createFields(projectKey, typeId, x) }))!;
  return res.key;
}

/** Update an issue sent before: summary, description, priority and parent; labels are added. False if it's gone. */
export async function updateIssue(cfg: JiraConfig, key: string, x: JiraIssueInput, f: Fetch = fetch): Promise<boolean> {
  const res = await call(
    cfg,
    f,
    "PUT",
    `/rest/api/3/issue/${encodeURIComponent(key)}?notifyUsers=false`,
    key,
    {
      fields: {
        summary: clip(x.summary),
        description: x.description,
        ...(x.priorityId ? { priority: { id: x.priorityId } } : {}),
        ...(x.parentKey ? { parent: { key: x.parentKey } } : {}),
      },
      update: { labels: x.labels.map((l) => ({ add: l })) },
    },
    true,
  );
  return res !== null;
}

/* ---------- Atlassian Document Format (issue descriptions) ---------- */

type AdfNode = { type: string; [k: string]: unknown };
export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

const txt = (text: string, marks?: AdfNode[]): AdfNode => ({ type: "text", text, ...(marks ? { marks } : {}) });
const strong = (text: string) => txt(text, [{ type: "strong" }]);
const link = (text: string, href: string) => txt(text, [{ type: "link", attrs: { href } }]);
/** Text with its line breaks kept; empty text gives nothing (ADF rejects empty text nodes). */
function lines(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  text
    .trim()
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (i) out.push({ type: "hardBreak" });
      if (line) out.push(txt(line));
    });
  return out;
}
const para = (...content: (AdfNode | AdfNode[] | null | false | undefined)[]): AdfNode => ({ type: "paragraph", content: content.flat().filter(Boolean) as AdfNode[] });
const heading = (text: string, level = 3): AdfNode => ({ type: "heading", attrs: { level }, content: [txt(text)] });
const bullets = (items: (AdfNode | AdfNode[])[]): AdfNode => ({ type: "bulletList", content: items.map((i) => ({ type: "listItem", content: [para(i)] })) });
const cell = (type: "tableHeader" | "tableCell", content: AdfNode[]): AdfNode => ({ type, content: [para(content.length ? content : [txt(" ")])] });
function table(head: string[], rows: AdfNode[][][]): AdfNode {
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [
      { type: "tableRow", content: head.map((h) => cell("tableHeader", [strong(h)])) },
      ...rows.map((r) => ({ type: "tableRow", content: r.map((c) => cell("tableCell", c)) })),
    ],
  };
}
const doc = (content: (AdfNode | null | false | undefined)[]): AdfDoc => ({ type: "doc", version: 1, content: content.filter(Boolean) as AdfNode[] });
const footer = (url: string) => para(txt("Sent from MatterTest. Edit it there and send again; edits made here are replaced. "), link("Open in MatterTest", url));

/** The plan's Epic: what it covers and where the risk is. */
export type JiraPlanInput = {
  code: string;
  name: string;
  version: number;
  focus?: string | null;
  summary?: string;
  scope: string[];
  outOfScope: string[];
  risks: { area: string; risk: string; why: string; priority: string }[];
  url: string;
};

export function planDescription(p: JiraPlanInput): AdfDoc {
  return doc([
    para(strong(`Test plan ${p.code}, version ${p.version}. `), txt("Each approved test case is a Task under this Epic.")),
    p.focus ? para(strong("Focus: "), ...lines(p.focus)) : null,
    p.summary ? para(...lines(p.summary)) : null,
    p.scope.length ? heading("In scope") : null,
    p.scope.length ? bullets(p.scope.map((s) => lines(s))) : null,
    p.outOfScope.length ? heading("Out of scope") : null,
    p.outOfScope.length ? bullets(p.outOfScope.map((s) => lines(s))) : null,
    p.risks.length ? heading("Risk-ranked areas") : null,
    p.risks.length ? table(["Area", "Risk", "Why", "Priority"], p.risks.map((r) => [[strong(r.area)], [txt(r.risk)], lines(r.why), [txt(r.priority)]])) : null,
    footer(p.url),
  ]);
}

/** One test case as a Task: why it exists (story, scenario, requirements) and how to run it. */
export type JiraCaseInput = {
  code: string;
  title: string;
  priority: string;
  kind: string;
  preconditions: string;
  testData: string;
  steps: { action: string; expected: string }[];
  automationCandidate: boolean;
  story?: { code: string; title: string; actor: string; want: string; soThat: string } | null;
  scenario: { code: string | null; title: string; actor?: string | null; situation?: string | null; outcome?: string | null };
  requirements: { code: string; title: string }[];
  url: string;
};

const KIND: Record<string, string> = { happy: "Positive", negative: "Negative", edge: "Edge case" };

export function caseDescription(c: JiraCaseInput): AdfDoc {
  const s = c.scenario;
  return doc([
    para(strong(`${c.code}`), txt(` · ${KIND[c.kind] ?? c.kind} · ${c.priority}${c.automationCandidate ? " · automation candidate" : ""}`)),
    c.story ? para(strong(`User story ${c.story.code}: `), txt(`${c.story.title}. As ${c.story.actor}, I want ${c.story.want}, so that ${c.story.soThat}.`)) : null,
    para(
      strong(`Scenario${s.code ? ` ${s.code}` : ""}: `),
      txt(s.title),
      s.situation ? txt(`. ${s.actor ? `${s.actor}: ` : ""}${s.situation}`) : null,
      s.outcome ? txt(` Outcome: ${s.outcome}`) : null,
    ),
    c.requirements.length ? para(strong("Requirements: "), txt(c.requirements.map((r) => (r.title ? `${r.code} ${r.title}` : r.code)).join("; "))) : null,
    c.preconditions.trim() ? heading("Preconditions") : null,
    c.preconditions.trim() ? para(...lines(c.preconditions)) : null,
    c.testData.trim() ? heading("Test data") : null,
    c.testData.trim() ? para(...lines(c.testData)) : null,
    heading("Steps"),
    table(["#", "Action", "Expected result"], c.steps.map((st, i) => [[txt(String(i + 1))], lines(st.action), lines(st.expected)])),
    footer(c.url),
  ]);
}
