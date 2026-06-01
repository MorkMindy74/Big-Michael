import { useState } from "react";
import { motion } from "framer-motion";
import { api } from "./api";
import type { SearchResult } from "./types";

export function Library({ onClose, notify }: { onClose: () => void; notify: (m: string) => void }) {
  const [mode, setMode] = useState<"ingest" | "search">("ingest");

  // ingest
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [docType, setDocType] = useState("contract");
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);

  // search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function ingest() {
    setBusy(true);
    try {
      const { id } = await api.ingestDocument({ title, content, jurisdiction, documentType: docType });
      setLastId(id);
      notify("Document ingested into the registry");
      setTitle(""); setContent("");
    } catch (e) { notify((e as Error).message); }
    finally { setBusy(false); }
  }

  async function search() {
    setSearching(true);
    try { setResults(await api.searchDocuments(query)); }
    catch (e) { notify((e as Error).message); }
    finally { setSearching(false); }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <motion.div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}>
        <div className="modal-head">
          <h3>The library</h3>
          <p>Ingest documents into the Qdrant knowledge registry, or search them semantically.</p>
        </div>

        <div className="tabs" style={{ margin: "16px 26px 0" }}>
          <button className={`tab ${mode === "ingest" ? "active" : ""}`} onClick={() => setMode("ingest")}>
            Ingest{mode === "ingest" && <motion.span layoutId="lib-underline" className="tab-underline" />}
          </button>
          <button className={`tab ${mode === "search" ? "active" : ""}`} onClick={() => setMode("search")}>
            Search{mode === "search" && <motion.span layoutId="lib-underline" className="tab-underline" />}
          </button>
        </div>

        {mode === "ingest" ? (
          <div className="modal-body">
            <div className="field">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Master Services Agreement — Acme / Beta" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div className="field">
                <label>Jurisdiction</label>
                <input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="e.g. US-NY, England & Wales, EU, SG" />
              </div>
              <div className="field">
                <label>Document type</label>
                <input value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="contract" />
              </div>
            </div>
            <div className="field">
              <label>Content</label>
              <textarea style={{ minHeight: 150 }} value={content} onChange={(e) => setContent(e.target.value)}
                placeholder="Paste the full text of the document…" />
            </div>
            {lastId && <div className="grid-meta">Last ingested: <span style={{ fontFamily: "var(--font-mono)", color: "var(--green)" }}>{lastId}</span></div>}
          </div>
        ) : (
          <div className="modal-body">
            <div className="field">
              <label>Semantic query</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && search()}
                  placeholder="e.g. exclusivity obligations under Article 101" />
                <button className="btn" disabled={searching || !query} onClick={search}>{searching ? "…" : "Search"}</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 300, overflowY: "auto" }}>
              {results.map((r) => (
                <div key={r.document.id} className="grid-wrap" style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <strong style={{ fontSize: 13.5 }}>{r.document.title}</strong>
                    <span className="pill blue">{(r.score * 100).toFixed(0)}%</span>
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>{r.excerpt}</div>
                  <div className="grid-meta" style={{ marginTop: 6 }}>{r.document.id}</div>
                </div>
              ))}
              {!results.length && !searching && <div className="placeholder" style={{ padding: 24 }}>No results yet.</div>}
            </div>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {mode === "ingest" && (
            <button className="btn primary" disabled={busy || title.trim().length < 3 || content.trim().length < 20} onClick={ingest}>
              {busy ? "Ingesting…" : "⊕ Ingest document"}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
