"use client";

import { useEffect, useState } from "react";

/** What the worker reports while a job runs (runs.summary.progress). */
export type Progress = { label: string; done: number; total: number; stepWeight: number; stepStartedAt: string; expectSec: number };

const clock = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * A progress bar for one agent run. Finished steps fill it exactly; the step under way fills towards its end as
 * time passes, based on how long that step usually takes, and holds just short of it until the worker moves on.
 */
export function RunProgress({ title, status, progress, startedAt }: { title: string; status: string; progress: Progress | null; startedAt: string | null }) {
  // The clock starts after hydration, so the server's render and the browser's first render match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  const queued = status === "queued";
  let pct = 0;
  let overdue = false;
  if (progress && progress.total > 0) {
    const elapsed = now === null ? 0 : (now - Date.parse(progress.stepStartedAt)) / 1000;
    const share = progress.expectSec > 0 ? elapsed / progress.expectSec : 1;
    overdue = share > 1.2;
    // Ease towards 95% of the step so a slow step still looks alive without claiming it's finished.
    const within = Math.min(0.95, share < 1 ? share : 0.9 + 0.05 * (1 - 1 / share));
    pct = Math.min(99, ((progress.done + progress.stepWeight * within) / progress.total) * 100);
  }
  const elapsedAll = startedAt && now !== null ? (now - Date.parse(startedAt)) / 1000 : null;
  const label = queued ? "Starts when the job above finishes" : (progress?.label ?? "Starting");

  return (
    <div className="run-progress">
      <div className="row small" style={{ justifyContent: "space-between", gap: 8, flexWrap: "nowrap" }}>
        <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{title}</span>
        <span className="muted nowrap">{queued ? "Queued" : `${Math.round(pct)}%`}</span>
      </div>
      <div
        className={`bar run-bar${queued ? " run-bar-waiting" : ""}`}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={queued ? undefined : Math.round(pct)}
        aria-valuetext={queued ? "Queued" : `${Math.round(pct)}%: ${label}`}
      >
        <span style={{ width: queued ? "0%" : `${pct}%` }} />
      </div>
      <span className="small muted">
        {label}
        {!queued && elapsedAll !== null ? ` · ${clock(elapsedAll)} so far` : ""}
        {overdue ? " · taking longer than usual" : ""}
      </span>
    </div>
  );
}
