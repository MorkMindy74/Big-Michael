import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Task } from "./types";
import { PHASE_SEQUENCES } from "./types";
import { StatusPill, WorkflowPill } from "./primitives";
import { FindingsTable } from "./FindingsTable";
import { TabulateGrid } from "./TabulateGrid";

type Tab = "findings" | "tabulate" | "synthesis" | "rounds";

function PhaseStepper({ task }: { task: Task }) {
  const phases = PHASE_SEQUENCES[task.workflowType];
  const currentIdx = phases.indexOf(task.currentPhase);
  const done = task.status === "complete";
  return (
    <div className="stepper">
      {phases.map((p, i) => {
        const isDone = done || i < currentIdx;
        const isCurrent = !done && i === currentIdx;
        return (
          <div key={p} className={`step ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`}>
            {i > 0 && <span className="step-link" />}
            <span className="step-node">
              <span className="step-num">{isDone ? "✓" : i + 1}</span>
              {p}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RoundsPanel({ task }: { task: Task }) {
  if (!task.rounds.length) return <div className="placeholder">No rounds executed yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {task.rounds.map((r) => (
        <div key={r.roundId} className="grid-wrap" style={{ padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className="pill gold">Round {r.goal.round}</span>
            <span className="pill blue">{r.goal.phase}</span>
            <span className="grid-meta">{r.edges.length} comm edges · {r.findings.length} findings · {r.activeAgentIds.length} agents</span>
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 13.5, lineHeight: 1.55 }}>{r.goal.description}</div>
        </div>
      ))}
    </div>
  );
}

export function TaskView({ task, onChange, notify }: {
  task: Task;
  onChange: () => void;
  notify: (msg: string) => void;
}) {
  const hasTable = !!task.table || task.workflowType === "tabulate";
  const initial: Tab = task.findings.length ? "findings" : task.output ? "synthesis" : "findings";
  const [tab, setTab] = useState<Tab>(initial);

  const pendingGates = task.pendingGates.filter((g) => g.status === "pending").length;

  const tabs: { id: Tab; label: string; count?: number; show: boolean }[] = [
    { id: "findings", label: "Findings", count: task.findings.length, show: true },
    { id: "tabulate", label: "Tabulate", count: task.table?.rows.length, show: hasTable },
    { id: "synthesis", label: "Synthesis", show: !!task.output },
    { id: "rounds", label: "Rounds", count: task.rounds.length, show: true },
  ];

  return (
    <div className="detail">
      <div className="task-head">
        <div className="eyebrow">
          <WorkflowPill workflow={task.workflowType} />
          <StatusPill status={task.status} />
          {pendingGates > 0 && <span className="pill amber">⚖ {pendingGates} awaiting review</span>}
          {task.error && <span className="pill red">{task.error}</span>}
        </div>
        <h1 className="task-title">{task.description}</h1>
        <div className="task-id">{task.id} · round {task.currentRound}/{task.maxRounds} · {task.findings.length} findings</div>
        <PhaseStepper task={task} />
      </div>

      <div className="tabs">
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count != null && <span className="tab-count">{t.count}</span>}
            {tab === t.id && <motion.span layoutId="tab-underline" className="tab-underline" />}
          </button>
        ))}
      </div>

      <div className="panel-body">
        <AnimatePresence mode="wait">
          <motion.div key={tab}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}>
            {tab === "findings" && <FindingsTable task={task} onChange={onChange} notify={notify} />}
            {tab === "tabulate" && <TabulateGrid task={task} />}
            {tab === "rounds" && <RoundsPanel task={task} />}
            {tab === "synthesis" && (
              task.output
                ? <div className="synthesis"><div className="synthesis-head">Final synthesis</div><div className="prose">{task.output}</div></div>
                : <div className="placeholder">Synthesis appears once all phases complete.</div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
