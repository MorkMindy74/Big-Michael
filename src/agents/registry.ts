// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { Config } from "../config.js";
import { embed, embedBatch } from "../embeddings.js";
import { logger } from "../logger.js";
import type { AgentDefinition, AgentTier, AgentDomain } from "../types.js";

// Backed by Qdrant in dev; drop in RuVector HTTP API for production.
// RuVector: https://github.com/ruvnet/RuVector — compatible REST API, add GNN self-learning.

const COLLECTION = Config.vectorDb.collections.agents;
const DIMS = Config.embeddings.dimensions;

// Stable namespace for agent string-ID → UUID v5 mapping.
// Same agent ID always maps to the same Qdrant point ID across restarts.
const AGENT_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // UUID namespace (DNS)

export class AgentRegistry {
  private readonly qdrant: QdrantClient;
  private ready = false;

  constructor() {
    this.qdrant = new QdrantClient({
      url: Config.vectorDb.url,
      apiKey: Config.vectorDb.apiKey,
    });
  }

  async init(): Promise<void> {
    const { collections } = await this.qdrant.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION);
    if (!exists) {
      await this.qdrant.createCollection(COLLECTION, {
        vectors: { size: DIMS, distance: "Cosine" },
        quantization_config: {
          scalar: { type: "int8", quantile: 0.99, always_ram: true },
        },
      });
      // Payload indexes — allow fast filtered searches without full-collection scans.
      // These are idempotent: safe to create even if the collection already exists.
      await Promise.all([
        this.qdrant.createPayloadIndex(COLLECTION, { field_name: "tier",         field_schema: "integer", wait: true }),
        this.qdrant.createPayloadIndex(COLLECTION, { field_name: "domain",       field_schema: "keyword", wait: true }),
        this.qdrant.createPayloadIndex(COLLECTION, { field_name: "jurisdictions", field_schema: "keyword", wait: true }),
      ]);
      logger.info("Agent registry collection created with indexes", { collection: COLLECTION });
    }
    this.ready = true;
  }

  async register(definition: AgentDefinition): Promise<void> {
    this.assertReady();
    const { embedding } = await embed(definition.description);
    await this.qdrant.upsert(COLLECTION, {
      wait: true,
      points: [
        {
          id: this.toPointId(definition.id),
          vector: embedding,
          payload: {
            ...definition,
            // Store allowedTools as a JSON string for Qdrant compat
            allowedToolsJson: JSON.stringify(definition.allowedTools),
            skillsJson: JSON.stringify(definition.skills),
          },
        },
      ],
    });
    logger.debug("Agent registered", { id: definition.id, name: definition.name });
  }

  async registerAll(definitions: AgentDefinition[]): Promise<void> {
    this.assertReady();
    const texts = definitions.map((d) => d.description);
    const embeddings = await embedBatch(texts);
    const points = definitions.map((def, i) => ({
      id: this.toPointId(def.id),
      vector: embeddings[i].embedding,
      payload: {
        ...def,
        allowedToolsJson: JSON.stringify(def.allowedTools),
        skillsJson: JSON.stringify(def.skills),
      },
    }));
    await this.qdrant.upsert(COLLECTION, { wait: true, points });
    logger.info("Agent batch registered", { count: definitions.length });
  }

  /**
   * Semantic search: find agents whose capabilities match the query.
   * Optionally filter by tier or domain.
   */
  async search(
    query: string,
    opts: { tier?: AgentTier; domain?: AgentDomain; topK?: number } = {},
  ): Promise<AgentDefinition[]> {
    this.assertReady();
    const { embedding } = await embed(query);

    const filter: Record<string, unknown> = {};
    const must: unknown[] = [];
    if (opts.tier !== undefined) {
      must.push({ key: "tier", match: { value: opts.tier } });
    }
    if (opts.domain !== undefined) {
      must.push({ key: "domain", match: { value: opts.domain } });
    }
    if (must.length) filter.must = must;

    const results = await this.qdrant.search(COLLECTION, {
      vector: embedding,
      limit: opts.topK ?? 10,
      filter: must.length ? filter : undefined,
      with_payload: true,
    });

    return results.map((r) => this.toDefinition(r.payload as Record<string, unknown>));
  }

  /**
   * Recommendation-based recruitment: blends semantic similarity with learned
   * agent performance. Pass point IDs of agents that performed well on similar
   * prior tasks (positive) and agents that underperformed (negative).
   *
   * Falls back to pure semantic search if positive examples are empty.
   * Used by DyTopo to improve recruitment quality over time.
   */
  async recommend(
    query: string,
    opts: {
      positive: string[];      // agentIds of high-performing agents from similar tasks
      negative?: string[];     // agentIds of low-performing agents (optional)
      tier?: AgentTier;
      topK?: number;
    },
  ): Promise<AgentDefinition[]> {
    this.assertReady();
    if (!opts.positive.length) return this.search(query, { tier: opts.tier, topK: opts.topK });

    const filter: Record<string, unknown> = {};
    const must: unknown[] = [];
    if (opts.tier !== undefined) must.push({ key: "tier", match: { value: opts.tier } });
    if (must.length) filter.must = must;

    const results = await this.qdrant.recommend(COLLECTION, {
      positive: opts.positive.map((id) => this.toPointId(id)),
      negative: (opts.negative ?? []).map((id) => this.toPointId(id)),
      limit: opts.topK ?? 10,
      filter: must.length ? filter : undefined,
      with_payload: true,
      strategy: "average_vector",
    });
    return results.map((r) => this.toDefinition(r.payload as Record<string, unknown>));
  }

  /**
   * Record agent task outcome for future recommend()-based recruitment.
   * Call after task completion — pass agent IDs from the round and the round's
   * average finding confidence. High confidence → positive example; low → negative.
   */
  async recordOutcome(agentIds: string[], avgConfidence: number): Promise<void> {
    this.assertReady();
    // Confidence ≥ 0.75 = strong signal; < 0.45 = weak signal.
    // We store a `successScore` payload field on each point that recommend()
    // can use as a ranking signal in future calls.
    const score = Math.max(0, Math.min(1, avgConfidence));
    const updates = agentIds.map((id) =>
      this.qdrant.setPayload(COLLECTION, {
        payload: { successScore: score },
        points: [this.toPointId(id)],
        wait: false,
      }),
    );
    await Promise.allSettled(updates);
    logger.debug("Agent outcome recorded", { count: agentIds.length, avgConfidence });

    // RuVector GNN feedback — only called when the endpoint is a RuVector host.
    // RuVector exposes /api/feedback with a quality_score field that flows into
    // the GNN self-learning layer without requiring reindexing.
    if (Config.vectorDb.ruVectorEnabled) {
      await this.sendRuVectorFeedback(score).catch((err) =>
        logger.warn("RuVector feedback failed", { error: (err as Error).message }),
      );
    }
  }

  private async sendRuVectorFeedback(qualityScore: number): Promise<void> {
    const base = Config.vectorDb.url.replace(/\/$/, "");
    const res = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(Config.vectorDb.apiKey ? { Authorization: `Bearer ${Config.vectorDb.apiKey}` } : {}) },
      body: JSON.stringify({ collection: COLLECTION, quality_score: qualityScore }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`RuVector feedback HTTP ${res.status}`);
  }

  async getById(id: string): Promise<AgentDefinition | null> {
    this.assertReady();
    const results = await this.qdrant.retrieve(COLLECTION, {
      ids: [this.toPointId(id)],
      with_payload: true,
    });
    if (!results.length) return null;
    return this.toDefinition(results[0].payload as Record<string, unknown>);
  }

  async listAll(): Promise<AgentDefinition[]> {
    this.assertReady();
    const result = await this.qdrant.scroll(COLLECTION, {
      limit: 500,
      with_payload: true,
    });
    return result.points.map((p) => this.toDefinition(p.payload as Record<string, unknown>));
  }

  // Deterministic UUID v5: same agentId always → same Qdrant point ID.
  private toPointId(agentId: string): string {
    return uuidv5(agentId, AGENT_NS);
  }

  private toDefinition(payload: Record<string, unknown>): AgentDefinition {
    return {
      id: payload.id as string,
      name: payload.name as string,
      tier: payload.tier as AgentDefinition["tier"],
      type: payload.type as AgentDefinition["type"],
      domain: payload.domain as AgentDefinition["domain"],
      description: payload.description as string,
      systemPrompt: payload.systemPrompt as string,
      skills: JSON.parse((payload.skillsJson as string) ?? "[]"),
      allowedTools: JSON.parse((payload.allowedToolsJson as string) ?? "[]"),
      // jurisdictions must be restored so the DyTopo jurisdiction filter fires
      // correctly for agents retrieved via semantic search (not just in-memory).
      jurisdictions: Array.isArray(payload.jurisdictions)
        ? (payload.jurisdictions as string[])
        : undefined,
      metadata: (payload.metadata as Record<string, unknown>) ?? undefined,
    };
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("AgentRegistry not initialised — call init() first");
  }
}