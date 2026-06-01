// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
//
// Fast unit tests for pure logic — no Qdrant, no network, no LLM.
// Run with: npm test   (node:test via tsx)

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { estimateComplexity } from "../src/routing/model.js";
import { LavernAdapter, fromMikeOSSWorkflow, instantiateTemplate } from "../src/adapters/lavern.js";
import { assertSafeReadPath } from "../src/tools/pdf.js";
import { canViewTask, filterVisible, isPartner } from "../src/auth/index.js";
import type { SessionUser } from "../src/types.js";

// ─── Model routing: complexity heuristic ────────────────────────────────────

test("estimateComplexity: two high-signal terms → high", () => {
  assert.equal(estimateComplexity("Assess the antitrust exposure and proportionality of the merger control remedy"), "high");
});

test("estimateComplexity: two low-signal terms → low", () => {
  assert.equal(estimateComplexity("Extract the parties and list the defined terms"), "low");
});

test("estimateComplexity: neutral text → medium", () => {
  assert.equal(estimateComplexity("Summarise the lease and note the rent review date"), "medium");
});

// ─── Lavern adapter: tier / domain inference + tool mapping ──────────────────

const adapter = new LavernAdapter();

test("Lavern: explicit orchestrator tier → T1 manager", () => {
  const [a] = adapter.fromConfigs([{ name: "Lead Counsel", role: "Coordinates the team", systemPrompt: "x", mcpTools: [], tier: "orchestrator" }]);
  assert.equal(a.tier, 1);
  assert.equal(a.type, "manager");
});

test("Lavern: explicit tool tier → T3 tool", () => {
  const [a] = adapter.fromConfigs([{ name: "Searcher", role: "search the web", systemPrompt: "x", mcpTools: ["mcp_search"], tier: "tool" }]);
  assert.equal(a.tier, 3);
  assert.equal(a.type, "tool");
});

test("Lavern: specialist defaults to T2 + maps MCP tools to internal names", () => {
  const [a] = adapter.fromConfigs([{ name: "Reviewer", role: "review contracts", systemPrompt: "x", mcpTools: ["mcp_search", "mcp_verify_citation"] }]);
  assert.equal(a.tier, 2);
  assert.equal(a.type, "specialist");
  assert.deepEqual(a.allowedTools, ["web_search", "citation_check"]);
});

test("Lavern: id is slugged + name is tagged + source metadata set", () => {
  const [a] = adapter.fromConfigs([{ name: "Risk Partner", role: "assess risk", systemPrompt: "x", mcpTools: [] }]);
  assert.equal(a.id, "lavern:risk-partner");
  assert.equal(a.name, "[Lavern] Risk Partner");
  assert.equal(a.metadata?.source, "lavern");
});

// ─── MikeOSS workflow → template + instantiation ─────────────────────────────

test("fromMikeOSSWorkflow: maps to a mikeoss-sourced template, default workflowType", () => {
  const t = fromMikeOSSWorkflow({ id: "cp-checklist", name: "CP Checklist", description: "d", promptTemplate: "Do {{x}}" });
  assert.equal(t.id, "mikeoss:cp-checklist");
  assert.equal(t.source, "mikeoss");
  assert.equal(t.workflowType, "roundtable");
});

test("instantiateTemplate: substitutes placeholders", () => {
  const t = fromMikeOSSWorkflow({ id: "t", name: "n", description: "d", promptTemplate: "Review {{company}} under {{law}} law", workflowType: "review" });
  const { description, workflowType } = instantiateTemplate(t, { company: "Acme", law: "New York" });
  assert.equal(description, "Review Acme under New York law");
  assert.equal(workflowType, "review");
});

// ─── Security: PDF read-path traversal guard ─────────────────────────────────

test("assertSafeReadPath: allows a path inside the project root", () => {
  const p = resolve(process.cwd(), "output", "documents", "brief.pdf");
  assert.equal(assertSafeReadPath(p), p);
});

test("assertSafeReadPath: blocks traversal to a sensitive file", () => {
  assert.throws(() => assertSafeReadPath(resolve(process.cwd(), "..", "..", "..", "Windows", "System32", "config")), /outside the allowed directories/);
});

test("assertSafeReadPath: blocks a relative .env escape", () => {
  // resolve() collapses ../ — anything that climbs out of an allowed root is refused
  assert.throws(() => assertSafeReadPath("../../../../etc/passwd"), /outside the allowed directories/);
});

test("assertSafeReadPath: rejects empty / non-string input", () => {
  assert.throws(() => assertSafeReadPath(""), /file path is required/);
  assert.throws(() => assertSafeReadPath(undefined), /file path is required/);
});

// ─── Access control: no inter-lawyer view unless partner-shared ──────────────

const partner: SessionUser = { profileId: "p1", name: "P", email: "p@x", role: "partner" };
const alice: SessionUser = { profileId: "a", name: "Alice", email: "a@x", role: "lawyer" };
const bob: SessionUser = { profileId: "b", name: "Bob", email: "b@x", role: "lawyer" };
const matters = [
  { assignedLawyerIds: ["a"] },           // Alice's
  { assignedLawyerIds: ["b"] },           // Bob's
  { assignedLawyerIds: ["a", "b"] },      // partner-shared across both
  { assignedLawyerIds: [] },              // unassigned
];

test("partner sees every matter", () => {
  assert.equal(isPartner(partner), true);
  assert.equal(filterVisible(partner, matters).length, 4);
});

test("a lawyer sees only their own matters (no inter-lawyer view)", () => {
  const visible = filterVisible(alice, matters);
  assert.equal(visible.length, 2);             // her solo matter + the shared one
  assert.ok(!visible.includes(matters[1]));    // never Bob's solo matter
  assert.equal(canViewTask(alice, matters[1]), false);
});

test("a partner-shared matter is visible to both assigned lawyers", () => {
  assert.equal(canViewTask(alice, matters[2]), true);
  assert.equal(canViewTask(bob, matters[2]), true);
});

test("unassigned matters are invisible to lawyers, visible to partners", () => {
  assert.equal(canViewTask(alice, matters[3]), false);
  assert.equal(canViewTask(partner, matters[3]), true);
});

test("no principal (unauthenticated) sees nothing", () => {
  assert.equal(filterVisible(null, matters).length, 0);
  assert.equal(canViewTask(null, matters[0]), false);
});
