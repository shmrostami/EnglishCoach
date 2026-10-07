import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { jobs, type DrizzleDb, type JobRow } from "@ec/db";

export function defaultBackoffMs(attempts: number): number {
  return Math.min(30_000, 2 ** attempts * 5_000);
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: {
    db: DrizzleDb;
    pollMs?: number;
    handle: (job: JobRow) => Promise<void>;
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
    this.opts.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId)).run();
    try {
      await this.opts.handle(job);
      this.opts.db.update(jobs).set({ status: "done", doneAt: Date.now() }).where(eq(jobs.id, jobId)).run();
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= job.maxAttempts) {
        this.opts.db.update(jobs)
          .set({ status: "failed", attempts, error: message })
          .where(eq(jobs.id, jobId)).run();
      } else {
        this.opts.db.update(jobs)
          .set({ status: "pending", attempts, error: message, nextRunAt: Date.now() + defaultBackoffMs(attempts) })
          .where(eq(jobs.id, jobId)).run();
      }
    }
  }
}
