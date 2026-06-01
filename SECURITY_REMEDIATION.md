# Big Michael Security Remediation Guide

**Risk Score: 72/100 (HIGH)**  
**Date: 2026-05-31**  
**Status: Critical vulnerabilities require immediate attention before production deployment**

---

## Executive Summary

Big Michael has **20 identified security vulnerabilities** across 6 categories. Five are **CRITICAL** and require immediate fixes:

1. **No authentication/authorization** on MCP server and REST API
2. **No task-level access control** - all users/agents can access all data
3. **Command injection risk** in PDF tool subprocess calls
4. **Prompt injection risk** in task descriptions sent to LLMs
5. **Unprotected audit log** containing sensitive task information

**Status:** **NOT PRODUCTION READY** without these fixes.

---

## Critical Vulnerabilities (Priority 1-2)

### 1. Missing Authentication & Authorization

**Severity:** CRITICAL (CVSS 9.1 & 8.6)  
**Files:** `src/mcp/server.ts`, REST API endpoints  
**Issue:** Any MCP client or HTTP request can:
- Submit new tasks
- Ingest documents  
- Approve/reject findings
- Search other users' documents
- Query system state

**Fix:**

```typescript
// src/mcp/server.ts - Add auth middleware

interface AuthContext {
  userId: string;
  roles: string[];
  permissions: string[];
}

async function authenticateRequest(req: any): Promise<AuthContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid authorization header');
  }
  
  const token = authHeader.slice(7);
  const decoded = await verifyToken(token); // Implement JWT verification
  return {
    userId: decoded.sub,
    roles: decoded.roles,
    permissions: decoded.permissions,
  };
}

// Apply to all MCP tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const auth = await authenticateRequest(request);
  
  switch (request.params.name) {
    case 'submit_task':
      return await handleSubmitTask(request.params.arguments, auth);
    case 'approve_gate':
      if (!auth.roles.includes('reviewer')) {
        throw new Error('Insufficient permissions');
      }
      return await handleApproveGate(request.params.arguments, auth);
    // ... etc
  }
});
```

**REST API:**

```typescript
// Add to Fastify initialization
import fastifyJwt from '@fastify/jwt';

fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET,
});

fastify.decorate('authenticate', async function(request: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    throw new Error('Unauthorized');
  }
});

// Protect endpoints
fastify.post('/tasks', { onRequest: [fastify.authenticate] }, async (req, res) => {
  const userId = req.user.sub;
  // ... handle task submission with userId scope
});
```

**Timeline:** 2-3 days  
**Test:** Auth integration tests, API key rotation testing

---

### 2. Task-Level Data Isolation

**Severity:** CRITICAL (CVSS 7.8)  
**Files:** `src/memory/index.ts`, `src/knowledge/index.ts`, `src/dytopo/engine.ts`  
**Issue:** All agents in any round can access:
- All documents in knowledge store (via search_knowledge)
- All memories from all tasks (via query_memory)
- Findings from unrelated tasks

**Fix:**

```typescript
// src/memory/index.ts - Scope queries to current task

async query(
  query: string,
  opts: {
    taskId: string;
    agentId?: string;
    topK?: number;
    beforeRound?: number;
  },
): Promise<MemoryEntry[]> {
  this.assertReady();
  const { embedding } = await embed(query);

  // CRITICAL: taskId filter MUST be present
  if (!opts.taskId) {
    throw new Error('taskId is required for memory isolation');
  }

  const must: unknown[] = [
    { key: "taskId", match: { value: opts.taskId } },  // ← ENFORCED
  ];
  
  // Optional agent scope
  if (opts.agentId) {
    must.push({ key: "agentId", match: { value: opts.agentId } });
  }
  
  // ... rest of query
}
```

```typescript
// src/knowledge/index.ts - Scope document access to task

async search(
  query: string,
  opts: {
    topK?: number;
    jurisdiction?: string;
    documentType?: string;
    taskId?: string;  // Add task scope
  } = {},
): Promise<SearchResult[]> {
  const must: unknown[] = [];
  
  // If taskId provided, only search documents from that task
  if (opts.taskId) {
    must.push({ key: "taskId", match: { value: opts.taskId } });
  } else if (process.env.NODE_ENV === 'production') {
    // In production, always require task scope
    throw new Error('Knowledge search requires taskId in production');
  }
  
  // ... rest of search
}
```

```typescript
// src/agents/base.ts - Pass task scope to tools

const toolCtx: ToolContext = {
  knowledge: refs.knowledge,
  memory: refs.memory,
  taskId: refs.taskId,  // ← Include task context
};

// Tool implementations must respect taskId
async function ingestDocument(params: any, ctx: ToolContext) {
  // Scope ingestion to current task
  const docId = await ctx.knowledge.ingest({
    ...params,
    taskId: ctx.taskId,  // ← CRITICAL
  });
}
```

**Timeline:** 3-4 days  
**Test:** Cross-task isolation tests, concurrent task tests

---

### 3. Secure PDF Processing

**Severity:** HIGH (CVSS 8.8)  
**Files:** `src/tools/pdf.ts`, Python subprocess calls  
**Issue:** Command injection when processing untrusted PDFs

**Fix:**

```typescript
// src/tools/pdf.ts - Use safe subprocess

import { spawn } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(require('child_process').execFile);

async function extractPdfText(filePath: string): Promise<string> {
  // 1. Validate file path
  const absolutePath = path.resolve(filePath);
  const uploadDir = path.resolve(Config.pdf.outputDir);
  
  if (!absolutePath.startsWith(uploadDir)) {
    throw new Error('Invalid file path - outside upload directory');
  }
  
  if (!fs.existsSync(absolutePath)) {
    throw new Error('File not found');
  }
  
  // 2. Use execFile with shell=false (prevents injection)
  // Arguments are passed as array, NOT joined string
  try {
    const result = await execFile(Config.pdf.pythonBin, [
      path.join(__dirname, '../scripts/pdf_tools.py'),
      'extract',
      absolutePath,  // Passed as separate arg, not concatenated
    ], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      // CRITICAL: shell=false is default but be explicit
      shell: false,
    });
    
    return result.stdout;
  } catch (error) {
    logger.error('PDF extraction failed', {
      file: absolutePath,
      error: error.message,
    });
    throw new Error('Failed to extract PDF text');
  }
}

// Python script also needs hardening (pdf_tools.py)
// Don't use shell commands, use proper Python libraries
```

**timeline:** 1-2 days  
**Test:** Malicious filename tests, path traversal tests, timeout tests

---

### 4. Prompt Injection Prevention

**Severity:** HIGH (CVSS 6.8)  
**Files:** `src/agents/base.ts`, `src/orchestrator.ts`  
**Issue:** Task descriptions directly included in system prompts without sanitization

**Fix:**

```typescript
// src/agents/base.ts - Sanitize user input

function sanitizeUserInput(text: string): string {
  // Remove markdown code blocks that might escape the prompt
  let sanitized = text
    .replace(/```[\s\S]*?```/g, '[CODE BLOCK REMOVED]')
    .replace(/```/g, '');
  
  // Limit length to prevent prompt overflow
  const MAX_LENGTH = 5000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH) + '\n[TRUNCATED]';
  }
  
  return sanitized;
}

async function process(ctx: AgentContext): Promise<Finding[]> {
  // CRITICAL: Sanitize task description before including in prompt
  const sanitizedTask = sanitizeUserInput(ctx.taskDescription);
  
  const prompt = buildProcessingPrompt(this.definition, {
    ...ctx,
    taskDescription: sanitizedTask,  // ← Use sanitized version
  });
  
  // ... rest of processing
}

function buildProcessingPrompt(definition: AgentDefinition, ctx: AgentContext): string {
  // Use structured format to prevent injection
  return `SYSTEM CONTEXT:
Agent: ${definition.name}
Role: ${definition.description}

TASK CONTEXT:
---BEGIN TASK---
${ctx.taskDescription}
---END TASK---

Your role: ${definition.systemPrompt}

Process the task and return findings in JSON format...`;
}
```

**Timeline:** 1-2 days  
**Test:** Prompt injection payload tests, jailbreak attempt tests

---

## High Priority Vulnerabilities (Priority 3-5)

### 5. Unprotected Audit Log

**Severity:** HIGH (CVSS 6.5)  
**Files:** `src/audit/index.ts`  
**Issue:** Audit log contains sensitive task descriptions, findings, citations - no access control

**Fix:**

```typescript
// src/audit/index.ts - Secure audit logging

import { chmod } from 'fs/promises';

export class AuditLogger {
  async write(partial: Omit<AuditEntry, "id" | "ts">): Promise<void> {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      ...partial,
    };

    if (Config.audit.enabled) {
      try {
        // Write to file
        await appendFile(Config.audit.logFile, JSON.stringify(entry) + "\n");
        
        // Set restrictive permissions (owner read/write only)
        // File permissions: 0600 = rw-------
        await chmod(Config.audit.logFile, 0o600);
      } catch (error) {
        // Don't fail task on audit error, but log it securely
        logger.error('Audit write failed (non-fatal)', {
          error: error.message,
          event: partial.event,
        });
      }
    }
  }

  // Add audit access control
  readRecent(taskId?: string, limit = 500, userId?: string): AuditEntry[] {
    const src = taskId
      ? this.buffer.filter((e) => e.taskId === taskId)
      : this.buffer;
    
    // Only return audit entries for tasks the user owns
    if (userId) {
      // Verify user owns these tasks before returning entries
      return src.filter((e) => userOwnsTask(userId, e.taskId));
    }
    
    return src.slice(-limit);
  }
}

// Also rotate logs
async function rotateAuditLog() {
  const logFile = Config.audit.logFile;
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupFile = `${logFile}.${timestamp}.gz`;
  
  // Compress old log
  const gzip = require('zlib').createGzip();
  const source = fs.createReadStream(logFile);
  const dest = fs.createWriteStream(backupFile);
  
  source.pipe(gzip).pipe(dest);
  
  // Clear main log
  await writeFile(logFile, '');
  await chmod(logFile, 0o600);
}
```

**Timeline:** 1 day  
**Test:** Permission verification tests, log rotation tests

---

### 6. API Key Management

**Severity:** MEDIUM-HIGH (CVSS 5.4)  
**Files:** `src/config.ts`, `src/embeddings.ts`  
**Issue:** Missing API keys fail silently or are logged

**Fix:**

```typescript
// src/config.ts - Require all essential secrets

function require(key: string, description?: string): string {
  const v = process.env[key];
  if (!v) {
    const msg = `Missing required environment variable: ${key}`;
    if (description) {
      logger.error(`${msg} (${description})`);
    }
    throw new Error(msg);
  }
  return v;
}

export const Config = {
  anthropic: {
    apiKey: require("ANTHROPIC_API_KEY", "Claude API key for LLM inference"),
    model: optional("ANTHROPIC_MODEL", "claude-opus-4-8"),
  },

  embeddings: {
    // CHANGED: Now required, not optional
    apiKey: require("OPENAI_API_KEY", "OpenAI API key for embeddings or use LOCAL_EMBEDDINGS=true"),
    model: optional("EMBEDDING_MODEL", "text-embedding-3-small"),
    dimensions: parseInt(optional("EMBEDDING_DIMENSIONS", "1536")),
  },

  // ... rest of config
};

// Add startup health check
async function validateSecrets(): Promise<void> {
  const required = [
    'ANTHROPIC_API_KEY',
    Config.local.localEmbeddings ? null : 'OPENAI_API_KEY',
  ].filter(Boolean);
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length) {
    throw new Error(`Missing secrets: ${missing.join(', ')}`);
  }
  
  logger.info('All required secrets validated');
}

// Call in src/index.ts
main():
  await validateSecrets();
  const orchestrator = new Orchestrator();
```

**Timeline:** 1 day  
**Test:** Missing secret tests, startup validation tests

---

## Medium Priority Fixes

### 7. Tool Access Control

**Severity:** MEDIUM (CVSS 6.3)  
**Files:** `src/agents/base.ts`, `src/tools/index.ts`  
**Issue:** `allowedTools` not enforced at runtime

**Fix:**

```typescript
// src/agents/base.ts - Runtime tool access check

private async runAgenticLoop(...): Promise<string> {
  // ... existing code ...
  
  for (const response of responses) {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    
    for (const toolUse of toolUseBlocks) {
      // CRITICAL: Verify tool is allowed
      if (!this.definition.allowedTools.includes(toolUse.name)) {
        logger.warn('Tool access denied', {
          agent: this.definition.id,
          tool: toolUse.name,
          allowed: this.definition.allowedTools,
        });
        
        // Return error to agent instead of calling tool
        const errorBlock: ProviderToolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool "${toolUse.name}" not in your allowedTools list`,
          is_error: true,
        };
        
        messages.push({ role: 'user', content: [errorBlock] });
        continue;
      }
      
      // Tool is allowed, execute it
      const result = await refs.toolRegistry.call(toolUse.name, toolUse.input, toolCtx);
      // ...
    }
  }
}
```

**Timeline:** 1 day

---

### 8. Input Validation in Knowledge Ingestion

**Severity:** MEDIUM (CVSS 6.8)  
**Files:** `src/knowledge/index.ts`  
**Issue:** Documents accepted without validation

**Fix:**

```typescript
// src/knowledge/index.ts - Validate documents

const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB
const BLOCKED_PATTERNS = [
  /ignore.*previous.*instruction/i,
  /disregard.*constraint/i,
  /system.*prompt/i,
];

async ingest(doc: Omit<Document, "id" | "ingestedAt">): Promise<string> {
  // 1. Size validation
  if (doc.content.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`Document too large: ${doc.content.length} > ${MAX_DOCUMENT_SIZE}`);
  }

  // 2. Title validation
  if (!doc.title || doc.title.length === 0) {
    throw new Error('Document title required');
  }

  // 3. Content validation - basic prompt injection check
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(doc.content.slice(0, 1000))) {
      logger.warn('Suspicious content pattern detected', { title: doc.title });
      // Could reject or flag for review
    }
  }

  // 4. Source validation
  if (doc.source && !isValidUrl(doc.source)) {
    throw new Error('Invalid source URL');
  }

  // ... rest of ingestion
}
```

**Timeline:** 1 day

---

## Implementation Plan

### Phase 1 (Week 1): Critical Security Fixes
- [ ] Implement JWT authentication for MCP and REST API
- [ ] Add task-scoped access control for knowledge and memory
- [ ] Secure PDF subprocess calls
- [ ] Sanitize task descriptions in prompts

### Phase 2 (Week 2): Audit & Logging
- [ ] Protect audit log with file permissions and encryption
- [ ] Add API key validation at startup
- [ ] Implement audit access control
- [ ] Add security event logging

### Phase 3 (Week 3): Input Validation & Tool Access
- [ ] Validate document ingestion
- [ ] Add runtime tool access control
- [ ] Implement prompt injection pattern detection
- [ ] Add rate limiting

### Phase 4 (Ongoing): Monitoring & Compliance
- [ ] Set up security monitoring
- [ ] Regular dependency audits
- [ ] Penetration testing
- [ ] Compliance verification (if required)

---

## Testing Checklist

### Authentication Tests
- [ ] Unauthenticated MCP calls rejected
- [ ] Invalid tokens rejected
- [ ] Expired tokens rejected
- [ ] Token refresh works

### Authorization Tests
- [ ] User can only access their tasks
- [ ] User cannot approve other users' gates
- [ ] Admin can access all tasks
- [ ] Role-based access enforced

### Data Isolation Tests
- [ ] Task A memory not visible to Task B
- [ ] Task A documents not searchable in Task B context
- [ ] Cross-agent data access prevented
- [ ] Memory queries return empty without task scope

### Injection Tests
- [ ] Prompt injection payloads in task descriptions sanitized
- [ ] Command injection in PDF filenames blocked
- [ ] Template injection in document titles blocked
- [ ] LLM jailbreak attempts detected

### API Key Tests
- [ ] Missing API keys fail startup
- [ ] API keys not logged
- [ ] API keys not exposed in errors
- [ ] Key rotation doesn't break system

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE-287: Improper Authentication](https://cwe.mitre.org/data/definitions/287.html)
- [CWE-345: Insufficient Verification of Data Authenticity](https://cwe.mitre.org/data/definitions/345.html)
- [CWE-94: Improper Control of Generation of Code](https://cwe.mitre.org/data/definitions/94.html)
- [CWE-78: Improper Neutralization of Special Elements used in OS Command](https://cwe.mitre.org/data/definitions/78.html)

---

## Next Steps

1. **Review with team** - Get security team sign-off on fix approach
2. **Create security branch** - Implement fixes in isolated branch
3. **Add security tests** - Comprehensive test suite for all fixes
4. **Code review** - Have security-experienced reviewer approve
5. **Staging validation** - Test all fixes in staging environment
6. **Security audit** - Consider hiring external security firm for penetration test
7. **Production rollout** - Deploy fixes with monitoring

---

**Report Generated:** 2026-05-31  
**Risk Score:** 72/100 (HIGH)  
**Status:** NOT PRODUCTION READY
