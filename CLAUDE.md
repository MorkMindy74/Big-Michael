# Big Michael

Multi-agent legal AI orchestration platform. Runs DyTopo rounds of granular
epistemic/conceptual/writing agents over a Qdrant vector registry, with a
debate + verification protocol on every finding before final synthesis.

## Quick start

```bash
# 1. Start infrastructure
docker compose up -d          # Qdrant (vector DB) + DocuSeal (e-signature)

# 2. Configure secrets
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY
# Optional: TAVILY_API_KEY (web search), DOCUSEAL_API_KEY (e-signature)
# Optional: INFISICAL_* vars to load all secrets from Infisical instead

# 3. Install deps
npm install
pip install -r requirements.txt   # PyMuPDF, Camelot, Tesseract

# 4. Verify everything works
npm run smoke-test

# 5. Start server (MCP stdio + REST API)
npm start               # production (requires npm run build first)
npm run dev             # dev mode with tsx watch
```

REST API at `http://localhost:3101`.
MCP server on stdio (activated when stdin is not a TTY — i.e. from Claude Code).

## Using from Claude Code

`.mcp.json` at the project root registers Big Michael as an MCP server.
When Claude Code opens this directory, it can call all 13 tools directly:

```
submit_task          — start a multi-agent legal task
get_task             — poll status + findings
list_tasks           — list all tasks
approve_gate / reject_gate  — human review of flagged findings
submit_from_template — run a pre-built workflow (eu-competition-brief etc.)
list_templates       — see available workflow templates
get_round            — inspect a specific DyTopo round
ingest_document      — add a document to the knowledge store
search_knowledge     — semantic search across documents
list_agents          — browse the agent registry
query_memory         — query inter-round memory
get_audit            — retrieve the structured audit log
```

Claude Code actuates Laverne agent configs (from `agents/laverne/*.json`) and
MikeOSS-derived workflow templates (from `src/templates/*.json`) by routing
tasks through Big Michael's DyTopo orchestration engine.

### Example Claude Code session

```
Use big-michael to research whether our planned acquisition of Acme GmbH
triggers a mandatory notification under EU Merger Regulation 139/2004.
Run a full_bench workflow.
```

Claude Code will call `submit_task`, poll `get_task`, approve any human
gates via `approve_gate`, and surface the final synthesis.

## Architecture

```
T0  Root Orchestrator (1)
    ↓ issues RoundGoals each phase
T1  Domain Managers (4)       — research / analysis / drafting / review
    ↓ DyTopo: Need/Offer matching → directed comm graph
T2  Epistemic agents (18)     — reason within a specific EU law framework
T2  Conceptual agents (8)     — own a specific legal concept (dominance, SIEC…)
T2  Writing agents (13)       — produce a specific document type
    ↓ tool_use agentic loop
T3  Tool agents (7)           — web_search, doc retrieval, extraction,
                                translation, citation check, signing (DocuSeal)
```

Each DyTopo round:
1. Every agent generates a Need/Offer descriptor (Haiku, ~10 tokens)
2. Engine cosine-matches Needs → Offers to build a directed comm graph
3. Matched agents receive routed messages from their Need partners
4. Agents process context + run their tool_use loops → produce Findings
5. Findings pass through CitationGate → Debate (Opus) → Verification (Haiku ×10)
6. Low-confidence or challenged Findings go to human gate before final output

## Key files

| Path | What it does |
|---|---|
| `src/index.ts` | Entry point — loads dotenv → Infisical → starts server |
| `src/config.ts` | All configuration, read from environment |
| `src/orchestrator.ts` | Task lifecycle, phase sequencing, synthesis |
| `src/dytopo/engine.ts` | Need/Offer matching, comm graph, round execution |
| `src/agents/definitions.ts` | All 47 agent definitions |
| `src/agents/base.ts` | Agent class — agentic loop, tool dispatch |
| `src/protocols/index.ts` | CitationGate, DebateProtocol, VerificationPipeline |
| `src/routing/model.ts` | Haiku/Sonnet/Opus/Ollama/Local routing by tier+task |
| `src/providers/` | Anthropic + Ollama/LM-Studio provider abstraction |
| `src/tools/index.ts` | All tool implementations + ToolRegistry |
| `src/tools/pdf.ts` | PyMuPDF/Camelot/Tesseract tools (via python subprocess) |
| `src/tools/docuseal.ts` | DocuSeal e-signature tools |
| `src/audit/index.ts` | Append-only JSONL audit log + SSE stream |
| `src/secrets/index.ts` | Infisical REST API loader |
| `src/auth/index.ts` | Lawyer profiles (practiceAreas, bio, role), RLS access control |
| `src/clients/index.ts` | Client roster, matter sub-lists, conflict-of-interest checks |
| `src/services/classifier.ts` | Haiku-based practice area detection + client identification on ingest |
| `src/mcp/server.ts` | MCP stdio server + Fastify REST API |
| `src/templates/*.json` | Task templates (eu-competition-brief etc.) |
| `scripts/pdf_tools.py` | Python PDF backend — called by tools/pdf.ts |
| `docker-compose.yml` | Qdrant + DocuSeal for local dev |

## Model routing

| Condition | Model |
|---|---|
| T0 root orchestrator | Opus |
| debate / synthesis / high complexity | Opus |
| T1 managers, T2 specialists, drafting | Sonnet |
| T3 tool agents, descriptors, extraction | Haiku |
| `OLLAMA_TIERS=3` + `OLLAMA_ENABLED=true` | T3 → local Ollama |
| `LOCAL_INFERENCE_TIERS=all` | Everything → LM Studio / vLLM / Jan |

## Adding a new agent

1. Add an `AgentDefinition` object to `src/agents/definitions.ts`
2. Add it to the `ALL_AGENT_DEFINITIONS` export
3. Set `tier` (0–3), `type`, `domain`, `systemPrompt`, `allowedTools`, `skills`
4. Run `npm run smoke-test` — the `Total agents >= 40` and `No duplicate IDs` checks will catch issues

## Adding a task template

1. Create `src/templates/<id>.json` with:
   ```json
   {
     "id": "my-template",
     "name": "Human-readable name",
     "description": "What this workflow does",
     "workflowType": "roundtable",
     "promptTemplate": "Analyse {{company}} for {{issue}} under EU law.",
     "substitutions": { "company": "...", "issue": "..." }
   }
   ```
2. TemplateStore auto-loads all `*.json` files from `src/templates/` on startup

## Adding Laverne agents

Place Laverne agent config JSON files in `agents/laverne/`.
They are loaded automatically via `LaverneAdapter` on startup and registered in the Qdrant agent registry.

## Local inference (LM Studio / Jan / Ollama)

```bash
# LM Studio — all tiers local
LOCAL_INFERENCE_URL=http://localhost:1234/v1
LOCAL_INFERENCE_MODEL=llama-3.2-3b-instruct
LOCAL_INFERENCE_TIERS=all

# Ollama — T3 tool agents only
OLLAMA_ENABLED=true
OLLAMA_MODEL=llama3.2
OLLAMA_TIERS=3
```

## Secrets (Infisical)

Only these vars need to be in `.env`; everything else lives in Infisical:

```bash
INFISICAL_CLIENT_ID=...
INFISICAL_CLIENT_SECRET=...
INFISICAL_PROJECT_ID=...
```

Self-host: `docker compose -f docker-compose.prod.yml up -d` from the Infisical repo.

## REST API endpoints

```
POST   /tasks                       submit task (auto-assigned to creator)
GET    /tasks                       list tasks (access-filtered)
GET    /tasks/:id                   get task (403→404 if not permitted)
DELETE /tasks/:id                   delete a matter
POST   /tasks/:id/assign            assign lawyer(s)        [partner only]
GET    /tasks/:id/stream            SSE live progress
POST   /tasks/from-template         submit from template
GET    /tasks/:taskId/rounds/:round get round state
POST   /tasks/:taskId/gates/:gateId/approve
POST   /tasks/:taskId/gates/:gateId/reject
POST   /documents                   ingest document (text) → returns practiceArea + detectedClient + suggestedLawyers
POST   /documents/upload            upload a PDF / text file → extract + ingest + classify
GET    /documents/search            semantic search (owner-scoped)
GET    /agents                      list agents
GET    /templates                   list templates
GET    /settings                    read admin settings
PUT    /settings                    update admin settings (live)
GET    /me                          current principal + authEnabled
GET    /profiles                    lawyer roster (includes practiceAreas, bio)
GET    /profiles/:id                single profile
POST   /profiles                    create lawyer             [partner only]
PATCH  /profiles/:id                update profile            [partner, or profile owner (no role change)]
DELETE /profiles/:id                remove lawyer             [partner only]
GET    /clients                     client roster             [partner only]
POST   /clients                     create client             [partner only]
PATCH  /clients/:id                 update client             [partner only]
DELETE /clients/:id                 delete client             [partner only]
POST   /clients/:id/matters         add matter to client      [partner only]
DELETE /clients/:id/matters/:num    remove matter             [partner only]
POST   /clients/check-conflict      check name against adversary lists  [partner only]
GET    /auth/providers              which OAuth providers are configured
GET    /auth/:provider/login        start OAuth login (google|microsoft|linkedin)
GET    /auth/:provider/callback     OAuth callback → session cookie
POST   /auth/logout                 clear session
GET    /audit                       query audit log (access-filtered)
GET    /audit/stream                SSE live audit stream (access-filtered)
GET    /health                      health check
```

### Access control

When `AUTH_ENABLED=true`, identity comes from OAuth (Google/Microsoft/LinkedIn)
and every request carries a `SessionUser` from the signed session cookie. A
**partner** sees all matters and manages assignment; a **lawyer** sees only
matters assigned to them. Locally (`AUTH_ENABLED=false`) every request is a
single local partner. See `src/auth/` and the README "Lawyers, roles & access
control" section. Access rules are unit-tested (`npm test`).

### Practice area classification

`src/services/classifier.ts` runs two Haiku calls on every document ingest:

1. **`detectPracticeArea(title, content)`** — classifies into one of 15 canonical practice areas. The canonical list lives in `src/types.ts` as `PRACTICE_AREAS` and is mirrored in `ui/src/types.ts`.
2. **`detectClient(title, content, clients)`** — matches the document against the known client roster by client number and name.

Both results are stored in the Qdrant document payload (`practiceArea`, `detectedClientNumber`) and returned from the REST API alongside `suggestedLawyers` — profiles whose `practiceAreas` include the detected area.

### Conflict of interest

`ClientStore.checkConflict(name)` does a case-insensitive substring match between the incoming client name and every existing client's `adversaries` array. It is called automatically on `POST /clients` and the result is included in the response. Partners can also call `POST /clients/check-conflict` standalone.

## Known limitations

- **Qdrant required**: all three stores (agent registry, memory, knowledge) require
  Qdrant to be running. `docker compose up -d` before starting Big Michael.
- **Python required**: PDF tools require Python 3.11+ and the packages in
  `requirements.txt`. Install with `pip install -r requirements.txt`.
- **Tesseract required** for OCR: `apt install tesseract-ocr` or `brew install tesseract`.
