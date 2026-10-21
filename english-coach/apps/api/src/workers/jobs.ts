import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { jobs, jobAttempts, type DrizzleDb, type JobRow } from "@ec/db";

export function defaultBackoffMs(attempts: number): number {
  return Math.min(30_000, 2 ** attempts * 5_000);
}

/**
 * A failure the caller can act on. `class` is a short stable label (e.g.
 * "validation") that survives into the API response; `message` is for humans.
 */
export class JobFailure extends Error {
  constructor(readonly class_: string, message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

function classify(err: unknown): { class: string; message: string } {
  if (err instanceof JobFailure) return { class: err.class_, message: err.message };
  if (err instanceof Error) {
    if (err.name === "ZodError") return { class: "validation", message: err.message };
    if (err.name === "TypeError") return { class: "type", message: err.message };
    return { class: "provider", message: err.message };
  }
  return { class: "unknown", message: String(err) };
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: {
    db: DrizzleDb;
    pollMs?: number;
    handle: (job: JobRow) => Promise<void>;
    /** Called once when a job exhausts its attempts, so the owner can move the
     *  affected row to a terminal state instead of leaving it stuck. */
    onFailed?: (job: JobRow, error: { class: string; message: string }) => void;
  }) {}

  enqueue(type: "analyze" | "plan_next", sessionId: string): void {
    try {
      this.opts.db.insert(jobs).values({
        id: `job-${randomUUID()}`,
        type,
        sessionId,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        createdAt: Date.now(),
      }).run();
    } catch {
      // UNIQUE(session_id, type) violation → duplicate enqueue, no-op
    }
  }

  /**
   * Re-queues a job that already exists for this (session, type). `enqueue`
   * cannot do this: UNIQUE(session_id, type) makes a fresh insert impossible, so
   * a retry has to reset the existing row instead.
   * Returns false when there is no such job.
   */
  reset(type: "analyze" | "plan_next", sessionId: string): boolean {
    const job = this.opts.db.select().from(jobs)
      .where(eq(jobs.sessionId, sessionId)).all()
      .find((j) => j.type === type);
    if (!job) return false;
    this.opts.db.update(jobs).set({
      status: "pending", attempts: 0, nextRunAt: null, error: null, doneAt: null,
    }).where(eq(jobs.id, job.id)).run();
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.opts.pollMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const due = this.opts.db.select().from(jobs)
      .where(eq(jobs.status, "pending"))
      .all()
      .filter((j) => j.nextRunAt === null || j.nextRunAt <= now);
    for (const job of due) {
      await this.processOne(job.id);
    }
  }

  async processOne(jobId: string): Promise<void> {
    const job = this.opts.db.select().from(jobs).where(eq(jobs.id, jobId)).all()[0];
    if (!job || job.status !== "pending") return;
    const attempt = job.attempts + 1;
    const startedAt = Date.now();
    const attemptId = `att-${randomUUID()}`;
    this.opts.db.insert(jobAttempts).values({
      id: attemptId, jobId, attempt, status: "running",
      errorClass: null, error: null, startedAt, finishedAt: null,
    }).run();
    this.opts.db.update(jobs).set({ status: "running", attempts: attempt }).where(eq(jobs.id, jobId)).run();
    try {
      await this.opts.handle(job);
      this.opts.db.update(jobs).set({ status: "done", doneAt: Date.now(), error: null }).where(eq(jobs.id, jobId)).run();
      this.opts.db.update(jobAttempts).set({ status: "done", finishedAt: Date.now() }).where(eq(jobAttempts.id, attemptId)).run();
    } catch (err) {
      const { class: errorClass, message } = classify(err);
      const attempts = attempt;
      this.opts.db.update(jobAttempts).set({ status: "failed", errorClass, error: message, finishedAt: Date.now() })
        .where(eq(jobAttempts.id, attemptId)).run();
      if (attempts >= job.maxAttempts) {
        this.opts.db.update(jobs)
          .set({ status: "failed", attempts, error: message })
          .where(eq(jobs.id, jobId)).run();
        this.opts.onFailed?.({ ...job, status: "failed", attempts, error: message }, { class: errorClass, message });
      } else {
        this.opts.db.update(jobs)
          .set({ status: "pending", attempts, error: message, nextRunAt: Date.now() + defaultBackoffMs(attempts) })
          .where(eq(jobs.id, jobId)).run();
      }
    }
  }
}
