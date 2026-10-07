import { eq } from "drizzle-orm";
import { jobs, sessions, type DrizzleDb } from "@ec/db";

/**
 * Stopgap job runner: polls the jobs table and runs the analysis pipeline
 * inline. Task 7 replaces this file with workers/jobs.ts (retry/backoff)
 * and workers/analysis.ts (memory updates). Interface is identical.
 */
export function startJobRunner(d: DrizzleDb, queue: (type: "analyze", sessionId: string) => void): { stop(): void } {
  void queue;
  const timer = setInterval(() => { void poll(); }, 1000);
  async function poll() {
    const now = Date.now();
    const due = d.select().from(jobs)
      .where(eq(jobs.status, "pending"))
      .all()
      .filter((j) => j.nextRunAt === null || j.nextRunAt <= now);
    for (const job of due) {
      try {
        runAnalyze(job);
      } catch (err) {
        console.error("analysis failed", err);
      }
    }
  }
  function runAnalyze(job: { id: string; sessionId: string | null }) {
    // Task 7's analysis worker is a superset of this; the stopgap only marks the session done.
    if (!job.sessionId) return;
    const session = d.select().from(sessions).where(eq(sessions.id, job.sessionId)).all()[0];
    if (!session || session.analysis) return; // idempotency
    d.update(jobs).set({ status: "done", doneAt: Date.now() }).where(eq(jobs.id, job.id)).run();
    d.update(sessions).set({ status: "COMPLETED", achievedDifficulty: session.plannedDifficulty })
      .where(eq(sessions.id, job.sessionId)).run();
  }
  return { stop: () => clearInterval(timer) };
}
