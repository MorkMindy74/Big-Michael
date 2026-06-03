// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { ToneProfile } from "../types.js";

const client = new Anthropic({ apiKey: Config.anthropic.apiKey });

// Posts per leaf-level analysis chunk. Small enough to fit comfortably in
// a single Haiku call; large enough to show meaningful style patterns.
const POST_CHUNK_SIZE = 8;

// Style notes per rollup chunk. Notes are longer than raw posts so we
// use a smaller fan-in to keep each rollup call tight.
const NOTE_CHUNK_SIZE = 6;

// Generous upper bound — chunking handles scale, so no need to hard-cap low.
const MAX_POSTS = 500;

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Strip structural prompt markers and control characters from user-supplied
 * text before embedding in any model prompt. Prevents crafted posts from
 * injecting fake FINDING blocks or overriding prompt instructions.
 */
function sanitizeForHaiku(s: string): string {
  return s
    .replace(/\bFINDING:/gi, "[FINDING:]")
    .replace(/\bEND_FINDING\b/gi, "[END_FINDING]")
    .replace(/\bNO_FINDINGS\b/gi, "[NO_FINDINGS]")
    .replace(/\bNO_CHALLENGE\b/gi, "[NO_CHALLENGE]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // ASCII control chars except tab/newline
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function haiku(content: string, maxTokens: number): Promise<string> {
  return client.messages
    .create({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content }] })
    .then((r) => ((r.content[0] as { type: string; text: string }).text ?? "").trim());
}

// ─── Leaf: analyse a single chunk of raw posts ────────────────────────────────

async function analyzeChunk(posts: string[], safeName: string): Promise<string> {
  const body = posts.map((p, i) => `---POST ${i + 1}---\n${p}`).join("\n\n");
  return haiku(
    `Analyse the writing style of ${safeName} from these ${posts.length} posts. ` +
    `Write a single dense paragraph (3–5 sentences) capturing: formality level, sentence structure, vocabulary register, rhetorical habits, and any distinctive phrases or transitions. ` +
    `Be specific — quote actual words or phrases observed. ` +
    `Plain prose only. No JSON, no headers, no bullet points.\n\n${body}`,
    300,
  );
}

// ─── Internal node: merge a batch of style notes ─────────────────────────────

async function rollupNotes(notes: string[], safeName: string): Promise<string> {
  const body = notes.map((n, i) => `[Observation ${i + 1}]\n${n}`).join("\n\n");
  return haiku(
    `Synthesise these ${notes.length} writing style observations for ${safeName} into one coherent paragraph. ` +
    `Preserve specific phrases and concrete patterns. Where observations conflict, note the variation briefly. ` +
    `Plain prose only. No JSON, no headers, no bullet points.\n\n${body}`,
    300,
  );
}

// ─── Root: convert final prose note → structured ToneProfile ─────────────────

async function buildProfile(
  finalNote: string,
  safeName: string,
  meta: { sampleCount: number; sourceType: ToneProfile["sourceType"] },
): Promise<ToneProfile> {
  const raw = await haiku(
    `Convert this writing style description for ${safeName} into structured JSON. ` +
    `Respond with ONLY valid JSON — no prose, no markdown fences.\n\n` +
    `Shape:\n` +
    `{\n` +
    `  "formality": "formal" | "semi-formal" | "conversational",\n` +
    `  "sentenceStyle": "long-complex" | "mixed" | "short-punchy",\n` +
    `  "vocabulary": "technical-heavy" | "balanced" | "plain-language",\n` +
    `  "rhetoricalStyle": "assertive" | "collaborative" | "hedging" | "analytical",\n` +
    `  "signaturePatterns": ["<specific observation>", ...],\n` +
    `  "injectionSnippet": "<3–5 sentence instruction for an LLM drafter to mirror this voice, starting with the lawyer's first name>"\n` +
    `}\n\n` +
    `signaturePatterns: 2–5 concrete observations quoting actual words or habits observed.\n` +
    `injectionSnippet: must read as a direct instruction, e.g. "${safeName} writes with directness and economy..."\n\n` +
    `Style description:\n${finalNote}`,
    800,
  );

  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("buildProfile returned invalid JSON");

  const p = JSON.parse(stripped.slice(s, e + 1)) as Record<string, unknown>;

  const pick = <T extends string>(val: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly unknown[]).includes(val) ? (val as T) : fallback;

  return {
    generatedAt: new Date().toISOString(),
    sourceType: meta.sourceType,
    sampleCount: meta.sampleCount,
    formality:      pick(p.formality,      ["formal", "semi-formal", "conversational"] as const, "semi-formal"),
    sentenceStyle:  pick(p.sentenceStyle,  ["long-complex", "mixed", "short-punchy"] as const,   "mixed"),
    vocabulary:     pick(p.vocabulary,     ["technical-heavy", "balanced", "plain-language"] as const, "balanced"),
    rhetoricalStyle:pick(p.rhetoricalStyle,["assertive", "collaborative", "hedging", "analytical"] as const, "analytical"),
    signaturePatterns: Array.isArray(p.signaturePatterns)
      ? (p.signaturePatterns as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 5)
      : [],
    injectionSnippet: typeof p.injectionSnippet === "string" && p.injectionSnippet
      ? p.injectionSnippet.slice(0, 1000)
      : `${safeName} — no distinctive style detected. Write in clear, professional legal English.`,
  };
}

// ─── Recursive rollup ─────────────────────────────────────────────────────────

async function recursiveRollup(
  items: string[],
  safeName: string,
  level: number,
  isRaw: boolean,
): Promise<string> {
  const chunkSize = isRaw ? POST_CHUNK_SIZE : NOTE_CHUNK_SIZE;
  const chunks = chunkArray(items, chunkSize);

  logger.debug("Tone rollup", { level, chunks: chunks.length, items: items.length, isRaw });

  // Process all chunks at this level in parallel
  const notes = await Promise.all(
    chunks.map((c) => (isRaw ? analyzeChunk(c, safeName) : rollupNotes(c, safeName))),
  );

  // Single note — recursion is complete
  if (notes.length === 1) return notes[0];

  // Multiple notes — recurse (notes are never raw)
  return recursiveRollup(notes, safeName, level + 1, false);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse writing samples using a chunked recursive rollup.
 *
 * Each leaf chunk of POST_CHUNK_SIZE posts is analysed in parallel by Haiku.
 * The resulting style notes are merged in parallel batches of NOTE_CHUNK_SIZE,
 * recursing until a single note remains. That note is converted to a
 * structured ToneProfile by a final Haiku call.
 *
 * Handles any number of posts up to MAX_POSTS with O(log n) depth and
 * full parallelism at every level — no context-window overflow, no truncation.
 */
export async function analyzeTone(
  samples: string[],
  lawyerName: string,
  sourceType: ToneProfile["sourceType"],
): Promise<ToneProfile> {
  const safeName = sanitizeForHaiku(lawyerName.trim().slice(0, 200));

  const posts = samples
    .map((s) => sanitizeForHaiku(s.trim()))
    .filter(Boolean)
    .slice(0, MAX_POSTS);

  if (!posts.length) throw new Error("No writing samples provided");

  logger.info("Tone analysis starting", { lawyer: safeName, posts: posts.length, sourceType });

  const finalNote = await recursiveRollup(posts, safeName, 0, true);
  const profile = await buildProfile(finalNote, safeName, { sampleCount: posts.length, sourceType });

  logger.info("Tone analysis complete", { lawyer: safeName, formality: profile.formality, rhetoric: profile.rhetoricalStyle });

  return profile;
}
