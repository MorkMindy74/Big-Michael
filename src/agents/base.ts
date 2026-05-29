import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type {
  AgentDefinition,
  AgentMessage,
  Finding,
  Citation,
  NeedDescriptor,
  OfferDescriptor,
  RoundGoal,
  MemoryEntry,
} from "../types.js";

const anthropic = new Anthropic({ apiKey: Config.anthropic.apiKey });

export interface AgentContext {
  roundGoal: RoundGoal;
  /** Messages routed to this agent via the DyTopo communication graph */
  incomingMessages: AgentMessage[];
  /** Inter-round memory entries retrieved for this agent */
  memoryEntries: MemoryEntry[];
  /** Task description for grounding */
  taskDescription: string;
}

export class Agent {
  readonly definition: AgentDefinition;

  constructor(definition: AgentDefinition) {
    this.definition = definition;
  }

  /**
   * Generate Need and Offer descriptors for this round.
   * These are embedded and matched by the DyTopo engine to form the comm graph.
   */
  async generateNeedOffer(ctx: AgentContext): Promise<{
    need: NeedDescriptor;
    offer: OfferDescriptor;
  }> {
    const prompt = buildNeedOfferPrompt(this.definition, ctx);
    const response = await this.callClaude(prompt, 400);
    const parsed = parseNeedOffer(response, this.definition.id);
    return parsed;
  }

  /**
   * Process the round goal + routed messages + memory, and produce findings.
   */
  async process(ctx: AgentContext): Promise<Finding[]> {
    const prompt = buildProcessingPrompt(this.definition, ctx);
    const response = await this.callClaude(prompt, 2000);
    return parseFindings(response, this.definition);
  }

  private async callClaude(userMessage: string, maxTokens: number): Promise<string> {
    logger.debug("Agent LLM call", { agent: this.definition.id, maxTokens });
    const msg = await anthropic.messages.create({
      model: Config.anthropic.model,
      max_tokens: maxTokens,
      system: this.definition.systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = msg.content[0];
    if (block.type !== "text") throw new Error("Unexpected content type from Claude");
    return block.text;
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildNeedOfferPrompt(def: AgentDefinition, ctx: AgentContext): string {
  return `TASK: ${ctx.taskDescription}

CURRENT ROUND GOAL (Round ${ctx.roundGoal.round}, Phase: ${ctx.roundGoal.phase}):
${ctx.roundGoal.description}

YOUR ROLE: ${def.name} (${def.domain})

INTER-ROUND MEMORY (relevant past findings):
${ctx.memoryEntries.length ? ctx.memoryEntries.map((e) => `[Round ${e.round}] ${e.content}`).join("\n") : "None yet."}

Based on the round goal and your role, output in this exact format:

NEED: <one sentence describing what information or expertise you currently require from other agents>
OFFER: <one sentence describing what knowledge or capability you can contribute this round>`;
}

function buildProcessingPrompt(def: AgentDefinition, ctx: AgentContext): string {
  const incoming = ctx.incomingMessages.length
    ? ctx.incomingMessages
        .map((m) => `[FROM: ${m.from}]\n${m.content}`)
        .join("\n\n---\n\n")
    : "No messages routed to you this round.";

  const memory = ctx.memoryEntries.length
    ? ctx.memoryEntries.map((e) => `[Round ${e.round}, Phase: ${e.phase}] ${e.content}`).join("\n")
    : "No prior memory entries.";

  return `TASK: ${ctx.taskDescription}

ROUND GOAL (Round ${ctx.roundGoal.round}, Phase: ${ctx.roundGoal.phase}):
${ctx.roundGoal.description}

EXPECTED OUTPUTS THIS ROUND:
${ctx.roundGoal.expectedOutputs.map((o, i) => `${i + 1}. ${o}`).join("\n")}

INTER-ROUND MEMORY:
${memory}

MESSAGES ROUTED TO YOU THIS ROUND:
${incoming}

─────────────────────────────────────────────────
Produce your findings below. For each finding:
1. State your finding clearly.
2. Provide at least one verbatim citation (source, quote, page if known).
3. State your confidence (0.0–1.0).

Format each finding as:
FINDING:
Content: <your finding>
Citation: SOURCE=<source> | QUOTE=<verbatim text> | PAGE=<page if known>
Confidence: <0.0–1.0>
END_FINDING

If you have no findings, output: NO_FINDINGS`;
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function parseNeedOffer(
  text: string,
  agentId: string,
): { need: NeedDescriptor; offer: OfferDescriptor } {
  const needMatch = text.match(/NEED:\s*(.+)/i);
  const offerMatch = text.match(/OFFER:\s*(.+)/i);
  return {
    need: { agentId, text: needMatch?.[1]?.trim() ?? "No specific need stated." },
    offer: { agentId, text: offerMatch?.[1]?.trim() ?? "No specific offer stated." },
  };
}

function parseFindings(text: string, def: AgentDefinition): Finding[] {
  if (text.includes("NO_FINDINGS")) return [];

  const blocks = text.split(/FINDING:/gi).slice(1);
  const findings: Finding[] = [];

  for (const block of blocks) {
    const end = block.indexOf("END_FINDING");
    const body = end >= 0 ? block.slice(0, end) : block;

    const contentMatch = body.match(/Content:\s*([\s\S]+?)(?=Citation:|Confidence:|$)/i);
    const citationMatches = [...body.matchAll(/Citation:\s*SOURCE=(.+?)\s*\|\s*QUOTE=(.+?)(?:\s*\|\s*PAGE=(.+?))?(?=Citation:|Confidence:|END_FINDING|$)/gi)];
    const confidenceMatch = body.match(/Confidence:\s*([\d.]+)/i);

    const content = contentMatch?.[1]?.trim();
    if (!content) continue;

    const citations: Citation[] = citationMatches.map((m) => ({
      source: m[1].trim(),
      quote: m[2].trim(),
      page: m[3] ? parseInt(m[3].trim()) : undefined,
      mechanicallyVerified: false, // verified later by citation-verifier-agent
    }));

    findings.push({
      id: crypto.randomUUID(),
      agentId: def.id,
      agentName: def.name,
      content,
      citations,
      confidence: parseFloat(confidenceMatch?.[1] ?? "0.7"),
      challenged: false,
      resolved: false,
      round: 0, // set by caller
      timestamp: new Date(),
    });
  }

  return findings;
}
