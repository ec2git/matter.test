"use server";

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { AGENT_INSTRUCTIONS_MAX, AGENT_NOTE_MAX, MAX_UPLOAD_BYTES, PLAN_FOCUS_MAX, PLAN_NAME_MAX, UPLOAD_TYPES, artefactPath, confluencePageRef, confluencePageUrl, loomVideoId, type SourceType } from "@mattertest/core";
import { clientQuestions, planTracks, projects, requirements, runs, scenarios, sources, tasks, testCases, testPlans, userStories } from "@mattertest/db";
import { requireUser } from "@/lib/auth";
import { agentQueue, db } from "@/lib/server";

export type FormState = { error?: string; ok?: string };

const Uuid = z.string().uuid();

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/assets`);
  revalidatePath(`/projects/${projectId}/review`);
  revalidatePath(`/projects/${projectId}`);
}

/** Create an ingest task + run for a source and queue it. If the queue is down, the run is marked failed. */
async function queueIngest(projectId: string, sourceId: string, title: string, requestedBy: string) {
  const [task] = await db.insert(tasks).values({ projectId, kind: "ingest", trigger: "manual", title, params: { sourceId, requestedBy } }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  try {
    await agentQueue().add("ingest", { taskId: task!.id, runId: run!.id, sourceId, thenPlan: true });
  } catch {
    const error = "Could not reach the job queue (is Redis running?)";
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
    await db.update(sources).set({ status: "failed", error }).where(eq(sources.id, sourceId));
    throw new Error(error);
  }
}

/** The optional note for the agent sent with a new source, trimmed; or an error if it's too long. */
function readNote(formData: FormData): { note?: string } | { error: string } {
  const note = String(formData.get("note") ?? "").trim();
  if (note.length > AGENT_NOTE_MAX) return { error: `Keep the note for the agent under ${AGENT_NOTE_MAX} characters (it's ${note.length}).` };
  return note ? { note } : {};
}

/** The note on the latest earlier version of a document, so a new version keeps it unless the team gives a new one. */
async function previousNote(projectId: string, match: { name: string } | { uri: string }): Promise<string | undefined> {
  const [prev] = await db
    .select({ meta: sources.meta })
    .from(sources)
    .where(and(eq(sources.projectId, projectId), "uri" in match ? eq(sources.uri, match.uri) : eq(sources.name, match.name)))
    .orderBy(desc(sources.version))
    .limit(1);
  return prev?.meta.note;
}

async function projectExists(projectId: string) {
  const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  return !!p;
}

/** The next version number for a source with this name or link. */
async function nextVersion(projectId: string, match: { name: string } | { uri: string }) {
  const [prev] = await db
    .select({ version: sources.version })
    .from(sources)
    .where(and(eq(sources.projectId, projectId), "uri" in match ? eq(sources.uri, match.uri) : eq(sources.name, match.name)))
    .orderBy(desc(sources.version))
    .limit(1);
  return (prev?.version ?? 0) + 1;
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(-80);

async function saveFile(projectId: string, hash: string, fileName: string, data: Buffer) {
  const uri = `sources/${projectId}/${hash.slice(0, 16)}-${safeName(fileName)}`;
  const full = artefactPath(uri);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return uri;
}

function readUpload(file: FormDataEntryValue | null, allowed: Record<string, SourceType>): { error: string } | { file: File; type: SourceType; ext: string } {
  if (!(file instanceof File) || !file.size) return { error: "Choose a file to upload." };
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = allowed[ext];
  if (!type) return { error: `${file.name} isn't a supported file. Use ${[...new Set(Object.keys(allowed))].map((e) => `.${e}`).join(", ")}.` };
  if (file.size > MAX_UPLOAD_BYTES) return { error: `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  return { file, type, ext };
}

/** Upload a PDF, DOCX, Markdown or transcript file as a new source (or a new version of one) and start ingesting it. */
export async function uploadSource(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  if (!(await projectExists(projectId))) return { error: "Project not found." };
  const up = readUpload(formData.get("file"), UPLOAD_TYPES);
  if ("error" in up) return up;
  const given = readNote(formData);
  if ("error" in given) return given;
  const data = Buffer.from(await up.file.arrayBuffer());
  const hash = createHash("sha256").update(data).digest("hex");

  const [same] = await db
    .select({ id: sources.id, name: sources.name, status: sources.status })
    .from(sources)
    .where(and(eq(sources.projectId, projectId), eq(sources.contentHash, hash), ne(sources.status, "failed")));
  if (same?.status === "removed") return { error: `This file was removed from the project (${same.name}). Restore it under Removed sources instead.` };
  if (same) return { error: `This file is already a source (${same.name}).` };

  const fileUri = await saveFile(projectId, hash, up.file.name, data);
  const version = await nextVersion(projectId, { name: up.file.name });
  const note = given.note ?? (version > 1 ? await previousNote(projectId, { name: up.file.name }) : undefined);
  const [source] = await db
    .insert(sources)
    .values({ projectId, type: up.type, name: up.file.name, fileUri, contentHash: hash, version, meta: note ? { note } : {}, createdBy: user.email })
    .returning();
  try {
    await queueIngest(projectId, source!.id, `Ingest ${up.file.name}`, user.email);
  } catch (e) {
    revalidate(projectId);
    return { error: (e as Error).message };
  }
  revalidate(projectId);
  return { ok: version > 1 ? `Uploaded version ${version} of ${up.file.name}. Reading it now.` : `Uploaded ${up.file.name}. Reading it now.` };
}

/** Add a Loom video by its share link. The worker reads its transcript, or asks for one if the video isn't public. */
export async function addLoomSource(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  if (!(await projectExists(projectId))) return { error: "Project not found." };
  const link = String(formData.get("link") ?? "").trim();
  const id = loomVideoId(link);
  if (!id) return { error: "Paste a Loom share link, like https://www.loom.com/share/…" };
  const uri = `https://www.loom.com/share/${id}`;
  const given = readNote(formData);
  if ("error" in given) return given;
  const [same] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.projectId, projectId), eq(sources.uri, uri), inArray(sources.status, ["queued", "ingesting", "ready", "needs-transcript"])));
  if (same) return { error: "This Loom video is already a source." };
  const version = await nextVersion(projectId, { uri });
  const [source] = await db
    .insert(sources)
    .values({ projectId, type: "loom", name: `Loom video ${id.slice(0, 8)}`, uri, contentHash: createHash("sha256").update(`loom:${id}`).digest("hex"), version, meta: given.note ? { note: given.note } : {}, createdBy: user.email })
    .returning();
  try {
    await queueIngest(projectId, source!.id, "Ingest Loom video", user.email);
  } catch (e) {
    revalidate(projectId);
    return { error: (e as Error).message };
  }
  revalidate(projectId);
  return { ok: "Added the Loom video. Reading its transcript now." };
}

/** Queue a Confluence job (add a page, or re-check the project's pages). If the queue is down, the run is marked failed. */
async function queueConfluence(projectId: string, title: string, data: { link?: string; includeChildren?: boolean; sync?: boolean; note?: string }, requestedBy: string) {
  const [task] = await db.insert(tasks).values({ projectId, kind: "ingest", trigger: "manual", title, params: { ...data, confluence: true, requestedBy } }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  try {
    await agentQueue().add("confluence", { taskId: task!.id, runId: run!.id, projectId, requestedBy, ...data });
  } catch {
    const error = "Could not reach the job queue (is Redis running?)";
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
    throw new Error(error);
  }
}

/** Add a Confluence page, optionally with its child pages. The worker reads them with the team's Confluence account. */
export async function addConfluencePage(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  if (!(await projectExists(projectId))) return { error: "Project not found." };
  const link = String(formData.get("link") ?? "").trim();
  const ref = confluencePageRef(link);
  if (!ref) return { error: "Paste a Confluence page or folder link, like https://yoursite.atlassian.net/wiki/spaces/DOCS/pages/123456/Page+title or …/spaces/DOCS/folder/123456" };
  const folder = "folderId" in ref;
  const includeChildren = folder || formData.get("includeChildren") === "on";
  const given = readNote(formData);
  if ("error" in given) return given;
  if ("pageId" in ref) {
    const [same] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.projectId, projectId), eq(sources.uri, confluencePageUrl(ref.origin, ref.pageId)), inArray(sources.status, ["queued", "ingesting", "ready"])));
    if (same && !includeChildren) return { error: "This page is already a source. Use “Check Confluence for updates” to pick up edits." };
  }
  try {
    await queueConfluence(projectId, folder ? "Add Confluence folder" : includeChildren ? "Add Confluence page and child pages" : "Add Confluence page", { link, includeChildren, ...given }, user.email);
  } catch (e) {
    revalidate(projectId);
    return { error: (e as Error).message };
  }
  revalidate(projectId);
  return { ok: folder ? "Reading the pages in the folder from Confluence now." : includeChildren ? "Reading the page and its child pages from Confluence now." : "Reading the page from Confluence now." };
}

/** Re-check every Confluence page in the project; changed and new child pages are read again and a new plan is drafted. */
export async function checkConfluence(formData: FormData) {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  try {
    await queueConfluence(projectId, "Check Confluence for updates", { sync: true }, user.email);
  } catch {
    // The failed run shows in Agent runs.
  }
  revalidate(projectId);
}

/** Save the project's standing instructions to the agent. They apply from the next read or plan. */
export async function saveInstructions(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  if (!(await projectExists(projectId))) return { error: "Project not found." };
  const text = String(formData.get("instructions") ?? "").trim();
  if (text.length > AGENT_INSTRUCTIONS_MAX) return { error: `Keep the instructions under ${AGENT_INSTRUCTIONS_MAX} characters (they're ${text.length}).` };
  await db.update(projects).set({ agentInstructions: text || null }).where(eq(projects.id, projectId));
  revalidate(projectId);
  return { ok: text ? "Saved. They apply the next time the agent reads a source or drafts the plan." : "Cleared. The agent works from the sources alone." };
}

const TRANSCRIPT_TYPES: Record<string, SourceType> = { vtt: "transcript", srt: "transcript", txt: "transcript" };

/** Attach a transcript file (.vtt, .srt, .txt downloaded from Loom) to a Loom source whose transcript couldn't be read, and ingest again. */
export async function attachTranscript(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const sourceId = Uuid.parse(formData.get("sourceId"));
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source || source.type !== "loom") return { error: "Source not found." };
  const up = readUpload(formData.get("file"), TRANSCRIPT_TYPES);
  if ("error" in up) return up;
  const data = Buffer.from(await up.file.arrayBuffer());
  const hash = createHash("sha256").update(data).digest("hex");
  const fileUri = await saveFile(source.projectId, hash, up.file.name, data);
  await db
    .update(sources)
    .set({ fileUri, status: "queued", error: null, meta: { ...source.meta, transcriptFrom: "upload" } })
    .where(eq(sources.id, source.id));
  try {
    await queueIngest(source.projectId, source.id, `Ingest transcript for ${source.meta.title ?? source.name}`, user.email);
  } catch (e) {
    revalidate(source.projectId);
    return { error: (e as Error).message };
  }
  revalidate(source.projectId);
  return { ok: "Transcript attached. Reading it now." };
}

/** Try a failed source again. */
export async function retrySource(formData: FormData) {
  const user = await requireUser();
  const sourceId = Uuid.parse(formData.get("sourceId"));
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) return;
  await db.update(sources).set({ status: "queued", error: null }).where(eq(sources.id, source.id));
  await queueIngest(source.projectId, source.id, `Ingest ${source.meta.title ?? source.name}`, user.email);
  revalidate(source.projectId);
}

/**
 * Take a source out of the project: its requirements stop feeding the plan and its open client questions are
 * withdrawn. Nothing is deleted, so it can be restored. The plan is flagged for re-drafting on Test assets.
 */
export async function removeSource(formData: FormData) {
  const user = await requireUser();
  const sourceId = Uuid.parse(formData.get("sourceId"));
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source || source.status === "removed" || source.status === "superseded" || source.status === "queued" || source.status === "ingesting") return;
  await db
    .update(sources)
    .set({ status: "removed", meta: { ...source.meta, removedFrom: source.status, removedBy: user.email } })
    .where(eq(sources.id, source.id));
  await db.update(clientQuestions).set({ status: "withdrawn" }).where(and(eq(clientQuestions.sourceId, source.id), eq(clientQuestions.status, "open")));
  revalidate(source.projectId);
}

/** Put a removed source back as it was: its requirements feed the plan again and its withdrawn questions reopen. */
export async function restoreSource(formData: FormData) {
  await requireUser();
  const sourceId = Uuid.parse(formData.get("sourceId"));
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source || source.status !== "removed") return;
  const { removedFrom, removedBy: _by, ...meta } = source.meta;
  await db.update(sources).set({ status: removedFrom && removedFrom !== "removed" ? removedFrom : "ready", meta }).where(eq(sources.id, source.id));
  await db.update(clientQuestions).set({ status: "open" }).where(and(eq(clientQuestions.sourceId, source.id), eq(clientQuestions.status, "withdrawn")));
  revalidate(source.projectId);
}

/**
 * Start a new test plan on its own topic. Its sources (already read) are extracted again with its focus, then its
 * first version is drafted. The project's other plans aren't touched.
 */
export async function createPlan(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  if (!(await projectExists(projectId))) return { error: "Project not found." };
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  const focus = String(formData.get("focus") ?? "").trim();
  if (!name) return { error: "Give the test plan a name, like “Click and collect”." };
  if (name.length > PLAN_NAME_MAX) return { error: `Keep the name under ${PLAN_NAME_MAX} characters.` };
  if (!focus) return { error: "Say what this plan covers, so the agent reads the sources for that topic only." };
  if (focus.length > PLAN_FOCUS_MAX) return { error: `Keep the focus under ${PLAN_FOCUS_MAX} characters (it's ${focus.length}).` };
  const existing = await db.select({ name: planTracks.name, position: planTracks.position, number: planTracks.number }).from(planTracks).where(eq(planTracks.projectId, projectId));
  if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) return { error: `There's already a test plan called “${name}”.` };

  const live = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.projectId, projectId), eq(sources.status, "ready")));
  const picked = formData.getAll("sourceId").map(String).filter((sid) => live.some((x) => x.id === sid));
  if (!picked.length) return { error: live.length ? "Pick at least one source for this plan." : "Add a source first; a test plan is drafted from the project's sources." };
  // Every ready source ticked means "all sources", including ones added later.
  const sourceIds = picked.length === live.length && formData.get("allSources") === "on" ? null : picked;

  const [track] = await db
    .insert(planTracks)
    .values({ projectId, number: Math.max(0, ...existing.map((t) => t.number)) + 1, name, focus, sourceIds, position: Math.max(-1, ...existing.map((t) => t.position)) + 1, createdBy: user.email })
    .returning();
  const [task] = await db.insert(tasks).values({ projectId, kind: "plan", trigger: "manual", title: `Start test plan: ${name}`, params: { trackId: track!.id, newPlan: true, requestedBy: user.email } }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  try {
    await agentQueue().add("track", { taskId: task!.id, runId: run!.id, projectId, trackId: track!.id });
  } catch {
    const error = "Could not reach the job queue (is Redis running?)";
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
  }
  revalidate(projectId);
  redirect(`/projects/${projectId}/assets?plan=${track!.id}`);
}

/** True while any agent job for the project is queued or running; plans aren't changed under a running job. */
async function projectBusy(projectId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), inArray(runs.status, ["queued", "running"])));
  return (row?.n ?? 0) > 0;
}

/**
 * Edit a test plan's name, focus and sources. A new name is saved as it is. A new focus or a different set of
 * sources means the plan is read again: its requirements and questions are replaced and a new version is drafted,
 * so earlier approvals in this plan start over.
 */
export async function editPlan(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const trackId = Uuid.parse(formData.get("trackId"));
  const [track] = await db.select().from(planTracks).where(eq(planTracks.id, trackId));
  if (!track) return { error: "Test plan not found." };
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  const focus = String(formData.get("focus") ?? "").trim();
  if (!name) return { error: "Give the test plan a name." };
  if (name.length > PLAN_NAME_MAX) return { error: `Keep the name under ${PLAN_NAME_MAX} characters.` };
  if (!focus) return { error: "Say what this plan covers, so the agent reads the sources for that topic only." };
  if (focus.length > PLAN_FOCUS_MAX) return { error: `Keep the focus under ${PLAN_FOCUS_MAX} characters (it's ${focus.length}).` };
  const [clash] = await db
    .select({ id: planTracks.id })
    .from(planTracks)
    .where(and(eq(planTracks.projectId, track.projectId), ne(planTracks.id, trackId), sql`lower(${planTracks.name}) = ${name.toLowerCase()}`));
  if (clash) return { error: `There's already a test plan called “${name}”.` };

  const live = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.projectId, track.projectId), eq(sources.status, "ready")));
  const picked = formData.getAll("sourceId").map(String).filter((sid) => live.some((x) => x.id === sid));
  if (!picked.length) return { error: "Pick at least one source for this plan." };
  const sourceIds = picked.length === live.length && formData.get("allSources") === "on" ? null : picked;
  const sameSources =
    sourceIds === null ? track.sourceIds === null : track.sourceIds !== null && [...track.sourceIds].filter((sid) => live.some((x) => x.id === sid)).sort().join() === [...sourceIds].sort().join();
  const reread = focus !== (track.focus ?? "") || !sameSources;
  if (reread && (await projectBusy(track.projectId))) return { error: "The agent is working on this project. Try again when it finishes." };

  await db.update(planTracks).set({ name, focus, sourceIds }).where(eq(planTracks.id, trackId));
  if (!reread) {
    revalidate(track.projectId);
    return { ok: "Saved." };
  }
  const [task] = await db.insert(tasks).values({ projectId: track.projectId, kind: "plan", trigger: "manual", title: `Read again for test plan: ${name}`, params: { trackId, requestedBy: user.email } }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  try {
    await agentQueue().add("track", { taskId: task!.id, runId: run!.id, projectId: track.projectId, trackId, reset: true });
  } catch {
    const error = "Could not reach the job queue (is Redis running?)";
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
    revalidate(track.projectId);
    return { error: `Saved, but ${error.toLowerCase()}.` };
  }
  revalidate(track.projectId);
  return { ok: "Saved. The agent is reading the sources again for this plan." };
}

/** Delete a test plan with everything drafted for it. The project keeps at least one plan. */
export async function deletePlan(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const trackId = Uuid.parse(formData.get("trackId"));
  const [track] = await db.select().from(planTracks).where(eq(planTracks.id, trackId));
  if (!track) return { error: "Test plan not found." };
  if (String(formData.get("confirm") ?? "").trim().toLowerCase() !== track.name.toLowerCase()) return { error: `Type the plan's name, “${track.name}”, to delete it.` };
  const [others] = await db.select({ n: sql<number>`count(*)::int` }).from(planTracks).where(and(eq(planTracks.projectId, track.projectId), ne(planTracks.id, trackId)));
  if (!others?.n) return { error: "This is the project's only test plan, so it can't be deleted. Edit it instead." };
  if (await projectBusy(track.projectId)) return { error: "The agent is working on this project. Try again when it finishes." };
  // Requirements, questions, versions, stories, scenarios and test cases go with the plan (cascading deletes).
  try {
    await db.delete(planTracks).where(eq(planTracks.id, trackId));
  } catch {
    return { error: "This plan's test cases have run history, so the plan can't be deleted yet." };
  }
  revalidate(track.projectId);
  redirect(`/projects/${track.projectId}/assets`);
}

/** Draft a new version of one test plan from its current requirements (e.g. after rejecting some). */
export async function regeneratePlan(formData: FormData) {
  const user = await requireUser();
  const projectId = Uuid.parse(formData.get("projectId"));
  const trackId = Uuid.parse(formData.get("trackId"));
  const [track] = await db.select({ name: planTracks.name }).from(planTracks).where(and(eq(planTracks.id, trackId), eq(planTracks.projectId, projectId)));
  if (!track) return;
  const [task] = await db.insert(tasks).values({ projectId, kind: "plan", trigger: "manual", title: `Draft test plan: ${track.name}`, params: { trackId, requestedBy: user.email } }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  try {
    await agentQueue().add("plan", { taskId: task!.id, runId: run!.id, projectId, trackId });
  } catch {
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), summary: { error: "Could not reach the job queue (is Redis running?)" } }).where(eq(runs.id, run!.id));
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, task!.id));
  }
  revalidate(projectId);
}

/* ---------- Review ---------- */

const Decision = z.enum(["approved", "rejected", "needs-review"]);
const ReviewInput = z.object({ kind: z.enum(["tc", "req", "plan", "story", "scenario"]), id: Uuid, decision: Decision });

async function projectOf(kind: "tc" | "req" | "plan" | "story" | "scenario", id: string): Promise<string | null> {
  if (kind === "scenario")
    return (await db.select({ p: testPlans.projectId }).from(scenarios).innerJoin(testPlans, eq(testPlans.id, scenarios.planId)).where(eq(scenarios.id, id)))[0]?.p ?? null;
  if (kind === "story")
    return (await db.select({ p: testPlans.projectId }).from(userStories).innerJoin(testPlans, eq(testPlans.id, userStories.planId)).where(eq(userStories.id, id)))[0]?.p ?? null;
  if (kind === "req") return (await db.select({ p: requirements.projectId }).from(requirements).where(eq(requirements.id, id)))[0]?.p ?? null;
  if (kind === "plan") return (await db.select({ p: testPlans.projectId }).from(testPlans).where(eq(testPlans.id, id)))[0]?.p ?? null;
  const [row] = await db
    .select({ p: testPlans.projectId })
    .from(testCases)
    .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
    .innerJoin(testPlans, eq(testPlans.id, scenarios.planId))
    .where(eq(testCases.id, id));
  return row?.p ?? null;
}

/** Approve, reject or reopen a requirement, plan or test case. */
export async function reviewItem(formData: FormData) {
  const user = await requireUser();
  const { kind, id, decision } = ReviewInput.parse(Object.fromEntries(formData));
  const projectId = await projectOf(kind, id);
  if (!projectId) return;
  const by = decision === "needs-review" ? { reviewedBy: null, reviewedAt: null } : { reviewedBy: user.email, reviewedAt: new Date() };
  if (kind === "req") await db.update(requirements).set({ reviewState: decision, ...by }).where(eq(requirements.id, id));
  if (kind === "tc") await db.update(testCases).set({ reviewState: decision, ...by }).where(eq(testCases.id, id));
  // A scenario's decision applies to all of its test cases.
  if (kind === "scenario") await db.update(testCases).set({ reviewState: decision, ...by }).where(and(eq(testCases.scenarioId, id), ne(testCases.reviewState, "superseded")));
  if (kind === "story") await db.update(userStories).set({ reviewState: decision, ...by }).where(eq(userStories.id, id));
  if (kind === "plan") await db.update(testPlans).set({ status: decision === "needs-review" ? "draft" : decision, ...by }).where(eq(testPlans.id, id));
  revalidate(projectId);
}

const StepsInput = z.object({
  id: Uuid,
  title: z.string().trim().min(1, "Give the test case a title"),
  preconditions: z.string().trim(),
  testData: z.string().trim(),
  approve: z.string().optional(),
});

/** Save a reviewer's edits to a test case (title, preconditions, test data, steps); optionally approve it too. */
export async function saveTestCase(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = StepsInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  const actions = formData.getAll("action").map((v) => String(v).trim());
  const expected = formData.getAll("expected").map((v) => String(v).trim());
  const steps = actions.map((action, i) => ({ action, expected: expected[i] ?? "" })).filter((s) => s.action || s.expected);
  const incomplete = steps.findIndex((s) => !s.action || !s.expected);
  if (!steps.length) return { error: "A test case needs at least one step." };
  if (incomplete >= 0) return { error: `Step ${incomplete + 1} needs both an action and an expected result.` };
  const { id, title, preconditions, testData, approve } = parsed.data;
  const projectId = await projectOf("tc", id);
  if (!projectId) return { error: "Test case not found." };
  await db
    .update(testCases)
    .set({ title, preconditions, testData, steps, edited: true, ...(approve ? { reviewState: "approved", reviewedBy: user.email, reviewedAt: new Date() } : {}) })
    .where(eq(testCases.id, id));
  revalidate(projectId);
  return { ok: approve ? "Saved and approved." : "Saved." };
}

const QuestionInput = z.object({ id: Uuid, status: z.enum(["open", "answered", "dismissed"]), answer: z.string().trim().optional() });

/** Record the client's answer to a question, or dismiss it. */
export async function updateQuestion(formData: FormData) {
  await requireUser();
  const { id, status, answer } = QuestionInput.parse(Object.fromEntries(formData));
  const [q] = await db.update(clientQuestions).set({ status, answer: answer || null }).where(eq(clientQuestions.id, id)).returning({ projectId: clientQuestions.projectId });
  if (q) revalidate(q.projectId);
}
