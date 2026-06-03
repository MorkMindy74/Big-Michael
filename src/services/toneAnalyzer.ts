// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { ToneProfile } from "../types.js";

const client = new Anthropic({ apiKey: Config.anthropic.apiKey });

/**
 * Analyse an array of writing samples (LinkedIn posts, emails, anything) and
 * return a structured ToneProfile including a ready-to-inject prompt snippet.
 *
 * Uses Haiku for speed and cost — tone analysis doesn't need heavy reasoning.
 */
export async function analyzeTone(
  samples: string[],
  lawyerName: string,
  sourceType: ToneProfile["sourceType"],
): Promise<ToneProfile> {
  const trimmed = samples
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50); // cap at 50 samples

  if (!trimmed.length) throw new Error("No writing samples provided");

  const joined = trimmed.map((s, i) => `[Sample ${i + 1}]\n${s}`).join("\n\n");
  // Cap total input to avoid large context costs
  const excerpt = joined.slice(0, 12_000);

  const prompt = `You are a writing style analyst. Analyse the following writing samples from ${lawyerName} and identify their distinctive tone and style. Respond with ONLY valid JSON — no prose, no markdown fences.

Use exactly this shape:
{
  "formality": "formal" | "semi-formal" | "conversational",
  "sentenceStyle": "long-complex" | "mixed" | "short-punchy",
  "vocabulary": "technical-heavy" | "balanced" | "plain-language",
  "rhetoricalStyle": "assertive" | "collaborative" | "hedging" | "analytical",
  "signaturePatterns": ["<pattern 1>", "<pattern 2>", "<pattern 3>"],
  "injectionSnippet": "<2–4 sentence paragraph describing the voice in second person, starting with the lawyer's first name, written so an LLM can mirror it>"
}

signaturePatterns: 2–5 specific, concrete observations (e.g. "opens paragraphs with declarative statements", "uses 'it is clear that' to signal conclusions", "favours short rhetorical questions").

injectionSnippet: write it as an instruction to an LLM drafter, e.g. "${lawyerName} writes with directness and economy. She favours short declarative sentences and signals transitions with 'Crucially,' and 'The key issue is'. She avoids passive voice and hedging language. Mirror this style in all drafted output."

Writing samples:
${excerpt}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (msg.content[0] as { type: string; text: string }).text?.trim() ?? "";
    const stripped = text.replace(/```(?:json)?/gi, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Tone analysis returned invalid JSON");
    }

    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;

    const formality = (["formal", "semi-formal", "conversational"] as const).find(
      (v) => v === parsed.formality,
    ) ?? "semi-formal";
    const sentenceStyle = (["long-complex", "mixed", "short-punchy"] as const).find(
      (v) => v === parsed.sentenceStyle,
    ) ?? "mixed";
    const vocabulary = (["technical-heavy", "balanced", "plain-language"] as const).find(
      (v) => v === parsed.vocabulary,
    ) ?? "balanced";
    const rhetoricalStyle = (["assertive", "collaborative", "hedging", "analytical"] as const).find(
      (v) => v === parsed.rhetoricalStyle,
    ) ?? "analytical";

    const signaturePatterns = Array.isArray(parsed.signaturePatterns)
      ? (parsed.signaturePatterns as unknown[])
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.slice(0, 200))
          .slice(0, 5)
      : [];

    const injectionSnippet =
      typeof parsed.injectionSnippet === "string" && parsed.injectionSnippet
        ? parsed.injectionSnippet.slice(0, 1000)
        : `${lawyerName} — no distinctive style pattern detected. Write in clear, professional legal English.`;

    return {
      generatedAt: new Date().toISOString(),
      sourceType,
      sampleCount: trimmed.length,
      formality,
      sentenceStyle,
      vocabulary,
      rhetoricalStyle,
      signaturePatterns,
      injectionSnippet,
    };
  } catch (err) {
    logger.warn("Tone analysis failed", { error: (err as Error).message });
    throw err;
  }
}
