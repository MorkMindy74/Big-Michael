import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { streamAudit } from "./api";
import type { AuditEntry } from "./types";

// Map event family → accent colour.
function tone(event: string): string {
  if (event.startsWith("gate")) return "var(--amber)";
  if (event.includes("complete") || event.includes("resolved") || event.includes("response")) return "var(--green)";
  if (event.includes("fail") || event.includes("reject")) return "var(--red)";
  if (event.startsWith("model") || event.startsWith("tool")) return "var(--blue)";
  if (event.startsWith("finding") || event.startsWith("debate") || event.startsWith("verification")) return "var(--gold)";
  return "var(--text-dim)";
}

function summary(e: AuditEntry): string {
  const d = e.data ?? {};
  const bits: string[] = [];
  if (e.agentId) bits.push(e.agentId);
  for (const k of ["phase", "round", "model", "findings", "gates", "workflow", "confidence", "passed"]) {
    if (d[k] != null) bits.push(`${k}=${d[k]}`);
  }
  if (e.durationMs != null) bits.push(`${e.durationMs}ms`);
  return bits.join(" · ");
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function AuditRail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const stop = streamAudit((entry) => {
      if (pausedRef.current) return;
      setEntries((prev) => [entry, ...prev].slice(0, 200));
    });
    return stop;
  }, []);

  return (
    <>
      <button className={`audit-fab ${open ? "on" : ""}`} onClick={onToggle} title="Live audit stream">
        <span className="audit-fab-dot" /> {open ? "▸" : "◂"} Audit
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside className="audit-rail"
            initial={{ x: 340 }} animate={{ x: 0 }} exit={{ x: 340 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}>
            <div className="audit-head">
              <div>
                <div className="audit-title">Live audit</div>
                <div className="audit-sub">{entries.length} events · append-only</div>
              </div>
              <button className="btn ghost sm" onClick={() => setPaused((p) => !p)}>
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </div>
            <div className="audit-feed">
              {entries.length === 0 && <div className="placeholder" style={{ fontSize: 13 }}>Waiting for activity…</div>}
              <AnimatePresence initial={false}>
                {entries.map((e) => (
                  <motion.div key={e.id} className="audit-row"
                    initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }} layout>
                    <span className="audit-time">{hhmmss(e.ts)}</span>
                    <span className="audit-evt" style={{ color: tone(e.event) }}>
                      <span className="audit-dot" style={{ background: tone(e.event) }} />
                      {e.event}
                    </span>
                    {summary(e) && <span className="audit-detail">{summary(e)}</span>}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
