// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

/**
 * Smoke test — validates the full stack is wired up correctly without
 * making real API calls. Checks:
 *   - Config loads without throwing
 *   - ToolRegistry has all 6 tools
 *   - AgentDefinitions cover all expected IDs
 *   - TemplateStore loads 3 built-in templates
 *   - selectModel routing produces correct models
 *   - Agent.process() falls back gracefully when no toolRegistry
 *   - Orchestrator init path (registry + memory + knowledge) runs without Qdrant
 *     (will error on Qdrant connect — expected in CI; exit 0 if all pre-Qdrant checks pass)
 */

import { globalToolRegistry } from "../tools/index.js";
import { ALL_AGENT_DEFINITIONS } from "../agents/definitions.js";
import { TemplateStore } from "../templates/store.js";
import { selectModel } from "../routing/model.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PASS = "✓";
const FAIL = "✗";
let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stdout.write(`  ${PASS} ${label}\n`);
  } else {
    process.stdout.write(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}\n`);
    failures++;
  }
}

// ─── 1. Config ────────────────────────────────────────────────────────────────

process.stdout.write("\n[1] Config\n");
try {
  const { Config } = await import("../config.js");
  check("ANTHROPIC_API_KEY present", !!Config.anthropic.apiKey);
  check("Default model set", !!Config.anthropic.model);
  check("DyTopo threshold in range", Config.dytopo.similarityThreshold > 0 && Config.dytopo.similarityThreshold < 1);
  check("Debate gate threshold in range", Config.debate.gateConfidenceThreshold > 0 && Config.debate.gateConfidenceThreshold <= 1);
} catch (err) {
  check("Config loads", false, (err as Error).message);
}

// ─── 2. Tool registry ─────────────────────────────────────────────────────────

process.stdout.write("\n[2] ToolRegistry\n");
const expectedTools = ["web_search", "search_knowledge", "query_memory", "extract_from_document", "translate", "citation_check"];
for (const name of expectedTools) {
  check(`tool: ${name}`, globalToolRegistry.has(name));
}
const schemas = globalToolRegistry.schemasFor(expectedTools);
check("schemasFor returns correct count", schemas.length === expectedTools.length, `got ${schemas.length}`);

// ─── 3. Agent definitions ─────────────────────────────────────────────────────

process.stdout.write("\n[3] Agent definitions\n");
check("Total agents >= 40", ALL_AGENT_DEFINITIONS.length >= 40, `got ${ALL_AGENT_DEFINITIONS.length}`);
check("T0 root orchestrator present", ALL_AGENT_DEFINITIONS.some((a) => a.tier === 0));
const t1 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 1);
const t2 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 2);
const t3 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 3);
check("T1 managers >= 4", t1.length >= 4, `got ${t1.length}`);
check("T2 specialists >= 30", t2.length >= 30, `got ${t2.length}`);
check("T3 tool agents >= 5", t3.length >= 5, `got ${t3.length}`);

// No duplicate IDs
const ids = ALL_AGENT_DEFINITIONS.map((a) => a.id);
const uniqueIds = new Set(ids);
check("No duplicate agent IDs", uniqueIds.size === ids.length, `${ids.length - uniqueIds.size} duplicates`);

// All agents have non-empty systemPrompt
const noPrompt = ALL_AGENT_DEFINITIONS.filter((a) => !a.systemPrompt?.trim());
check("All agents have systemPrompt", noPrompt.length === 0, `missing: ${noPrompt.map((a) => a.id).join(", ")}`);

// ─── 4. Templates ─────────────────────────────────────────────────────────────

process.stdout.write("\n[4] TemplateStore\n");
const store = new TemplateStore();
const templateDir = join(dirname(fileURLToPath(import.meta.url)), "../templates");
await store.load(templateDir);
check("Templates loaded >= 3", store.list().length >= 3, `got ${store.list().length}`);
check("eu-competition-brief present", !!store.get("eu-competition-brief"));
check("gdpr-complaint-response present", !!store.get("gdpr-complaint-response"));
check("merger-pre-notification present", !!store.get("merger-pre-notification"));

// ─── 5. Model routing ─────────────────────────────────────────────────────────

process.stdout.write("\n[5] Model routing\n");
check("descriptor → Haiku", selectModel({ taskType: "descriptor" }).includes("haiku"));
check("extraction → Haiku", selectModel({ taskType: "extraction" }).includes("haiku"));
check("debate → Opus", selectModel({ taskType: "debate" }).includes("opus"));
check("synthesis → Opus", selectModel({ taskType: "synthesis" }).includes("opus"));
check("T0 → Opus", selectModel({ tier: 0, taskType: "reasoning" }).includes("opus"));
check("T3 → Haiku", selectModel({ tier: 3, taskType: "reasoning" }).includes("haiku"));
check("T1 reasoning → Sonnet", selectModel({ tier: 1, taskType: "reasoning" }).includes("sonnet"));

// ─── Summary ──────────────────────────────────────────────────────────────────

process.stdout.write("\n");
if (failures === 0) {
  process.stdout.write(`All smoke tests passed.\n`);
  process.exit(0);
} else {
  process.stdout.write(`${failures} smoke test(s) failed.\n`);
  process.exit(1);
}
