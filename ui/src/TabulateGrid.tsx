import { useMemo, useState } from "react";
import {
  createColumnHelper, flexRender, getCoreRowModel, getFilteredRowModel,
  getSortedRowModel, useReactTable, type SortingState, type ColumnDef,
} from "@tanstack/react-table";
import { motion } from "framer-motion";
import type { Task, TaskTable } from "./types";
import { api } from "./api";
import { ConfidenceBar } from "./primitives";

type Row = Record<string, string>;
const col = createColumnHelper<Row>();

export function TabulateGrid({ task }: { task: Task }) {
  const t: TaskTable | undefined = task.table;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");

  const hasConf = (t?.rows ?? []).some((r) => r._confidence);
  const columns = useMemo<ColumnDef<Row, any>[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: any[] = (t?.columns ?? []).map((name) =>
      col.accessor((r) => r[name], { id: name, header: name, cell: (c) => c.getValue() as string }),
    );
    if (hasConf) {
      base.push(
        col.accessor((r) => parseFloat(r._confidence || "0"), {
          id: "__confidence",
          header: "Confidence",
          cell: (c) => {
            const n = Number(c.getValue());
            const sources = c.row.original._sources;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <ConfidenceBar value={n} />
                {sources && Number(sources) > 1 && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-faint)" }}>
                    {sources} findings merged
                  </span>
                )}
              </div>
            );
          },
        }),
      );
    }
    return base;
  }, [t?.columns, hasConf]);

  const table = useReactTable({
    data: t?.rows ?? [],
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (!t) {
    if (task.workflowType === "tabulate" && task.status !== "complete") {
      return <div className="placeholder">The spreadsheet is generated at delivery — still in progress.</div>;
    }
    return <div className="placeholder">No structured table for this task. Run a <em>tabulate</em> workflow to extract one.</div>;
  }

  return (
    <div>
      <div className="grid-toolbar">
        <div className="search">
          <span className="ico">⌕</span>
          <input placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="grid-meta">{table.getRowModel().rows.length} rows · {t.columns.length} cols</span>
          <a className="btn sm" href={api.tableCsvUrl(task.id)} download>⤓ Export CSV</a>
        </div>
      </div>

      <div className="grid-wrap">
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const dir = h.column.getIsSorted();
                    return (
                      <th key={h.id} onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {dir && <span className="sort">{dir === "asc" ? "▲" : "▼"}</span>}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row, i) => (
                <motion.tr key={row.id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.25 }}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
