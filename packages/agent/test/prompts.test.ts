import { describe, expect, it } from "vitest";
import { EXTRACT_SYSTEM, PLAN_SYSTEM, extractUser, planUser, type Passage } from "../src/prompts";

const ctx = { project: "Checkout v2", client: "Northwind", platform: "bigcommerce" };
const passages: Passage[] = [{ ref: "c1", sourceName: "brief.md", sourceType: "md", sectionPath: "Shipping", locator: {}, text: "Free over $99." }];

describe("team instructions in prompts", () => {
  it("puts the project's instructions and the source note in the extraction message, escaped", () => {
    const user = extractUser({ ...ctx, sourceName: "brief.md", sourceType: "md", passages, instructions: "  Focus on <checkout> & skip marketing.  ", sourceNote: "Only section 4 applies." });
    expect(user).toContain("<team_instructions>\nFocus on &lt;checkout&gt; &amp; skip marketing.\n</team_instructions>");
    expect(user).toContain("<source_note>\nOnly section 4 applies.\n</source_note>");
    // Instructions come before the source, so the passages stay one block.
    expect(user.indexOf("<team_instructions>")).toBeLessThan(user.indexOf("<source>"));
  });

  it("leaves both out when they're empty", () => {
    const user = extractUser({ ...ctx, sourceName: "brief.md", sourceType: "md", passages, instructions: "   ", sourceNote: null });
    expect(user).not.toContain("team_instructions");
    expect(user).not.toContain("source_note");
  });

  it("names Confluence pages as such", () => {
    expect(extractUser({ ...ctx, sourceName: "Spec", sourceType: "confluence", passages })).toContain('a Confluence page');
  });

  it("gives the planner the instructions and the notes on each source", () => {
    const user = planUser({ ...ctx, requirements: [], passages, openQuestions: [], instructions: "Payments are P0.", sourceNotes: [{ source: "brief.md", note: "Draft from May" }, { source: "x", note: " " }] });
    expect(user).toContain("<team_instructions>\nPayments are P0.\n</team_instructions>");
    expect(user).toContain("- brief.md: Draft from May");
    expect(user).not.toContain("- x:");
  });

  it("tells the model instructions can't stand in for the sources", () => {
    expect(EXTRACT_SYSTEM).toMatch(/team_instructions[\s\S]*never replace the sources/);
    expect(PLAN_SYSTEM).toMatch(/team_instructions[\s\S]*never replace the sources/);
  });
});

describe("plan focus", () => {
  it("tells extraction and planning which test plan they're for, after the team's instructions", () => {
    const user = extractUser({ ...ctx, sourceName: "Spec", sourceType: "confluence", passages, instructions: "AU only.", sourceNote: "Booking only", planName: "Click & collect", focus: " Pickup and store hours " });
    expect(user).toContain('<plan_focus plan="Click &amp; collect">\nPickup and store hours\n</plan_focus>');
    expect(user.indexOf("<team_instructions>")).toBeLessThan(user.indexOf("<plan_focus"));
    expect(user.indexOf("<plan_focus")).toBeLessThan(user.indexOf("<source_note>"));
    expect(user).toMatch(/fall within the plan focus\.$/);
    expect(planUser({ ...ctx, requirements: [], passages, openQuestions: [], planName: "Booking", focus: "Bookings" })).toContain('<plan_focus plan="Booking">');
  });

  it("leaves the focus out when the plan covers everything", () => {
    expect(extractUser({ ...ctx, sourceName: "Spec", sourceType: "md", passages, planName: "Test plan", focus: null })).not.toContain("plan_focus");
  });

  it("says the plan focus decides the topic over a source note", () => {
    expect(EXTRACT_SYSTEM).toMatch(/plan_focus decides what's in scope/);
    expect(PLAN_SYSTEM).toMatch(/<plan_focus>[\s\S]*covers that topic only/);
  });
});

describe("approved work in the plan prompt", () => {
  it("lists approved stories and test cases and asks Claude to keep them", () => {
    const user = planUser({
      ...ctx,
      requirements: [],
      passages,
      openQuestions: [],
      kept: {
        stories: [{ ref: "A1", key: "US-02", title: "Close a store", actor: "admin", want: "close a store for a day", soThat: "nobody books it", requirementKeys: ["REQ-03"], critical: true }],
        scenarios: [{ key: "SC-007", title: "Admin closes Penrith", kind: "happy", priority: "P0", requirementKeys: ["REQ-03"], storyRef: "A1", cases: [{ key: "TC-010", title: "Admin adds a closing day" }] }],
      },
    });
    expect(user).toContain("Already approved by the team. Keep these exactly as they are");
    expect(user).toContain("- A1 (US-02, critical): Close a store. As a admin, I want to close a store for a day, so that nobody books it. Covers REQ-03.");
    expect(user).toContain("- SC-007 [happy, P0] Admin closes Penrith (REQ-03) under A1: TC-010 Admin adds a closing day");
    expect(user.indexOf("Already approved")).toBeLessThan(user.indexOf("<passages>"));
  });

  it("says nothing about approved work when there is none", () => {
    expect(planUser({ ...ctx, requirements: [], passages, openQuestions: [], kept: { stories: [], scenarios: [] } })).not.toContain("Already approved");
  });
});

