import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "voice_sidecar.py");

/** First interpreter on PATH that answers `--version` (python / python3 / py). */
function findPython(): string | null {
  for (const cmd of ["python", "python3", "py"]) {
    try {
      if (spawnSync(cmd, ["--version"], { timeout: 5000 }).status === 0) return cmd;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const python = findPython();
const SKIP = !python || !existsSync(SCRIPT);

/** Resolve the next newline-terminated line from the child's stdout. */
function readline(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for a stdout line (stderr: ${stderrTail.trim() || "empty"})`)),
      timeoutMs,
    );
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        child.stdout!.off("data", onData);
        clearTimeout(timer);
        resolve(line);
      }
    };
    child.stdout!.on("data", onData);
  });
}

/** The child's stderr, kept so a failed handshake can say WHY. */
let stderrTail = "";

describe.skipIf(SKIP)("voice_sidecar.py (real Python)", () => {
  let child: ChildProcess;

  // 1 s of silence = 16000 int16 samples = 32000 bytes = 64000 hex chars.
  const SILENCE = Buffer.alloc(32000).toString("hex");

  it("loads Whisper, announces ready, transcribes, pings, tolerates bad input, and exits on bye", async () => {
    stderrTail = "";
    child = spawn(python!, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WHISPER_MODEL: "small", PIPER_DATA_DIR: "data/piper" },
    });
    child.stderr!.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-4_000); });

    // 1) ready handshake (Whisper load is a ~4 s cache-hit here; allow plenty)
    const ready = JSON.parse(await readline(child, 120_000)) as { ready?: boolean };
    // The child's own stderr is the difference between "Whisper is still
    // loading" and "faster_whisper is not installed" — without it a timeout
    // is indistinguishable from a broken install.
    expect(ready.ready, `sidecar stderr: ${stderrTail}`).toBe(true);

    // 2) stt over the wire (hex PCM16 in, text out). Silence must not throw.
    child.stdin!.write(JSON.stringify({ op: "stt", audio: SILENCE }) + "\n");
    const stt = JSON.parse(await readline(child, 60_000)) as { ok: boolean; text?: string };
    expect(stt.ok).toBe(true);
    expect(typeof stt.text).toBe("string");

    // 3) ping round-trips
    child.stdin!.write(JSON.stringify({ op: "ping" }) + "\n");
    const ping = JSON.parse(await readline(child, 10_000)) as { ok: boolean };
    expect(ping.ok).toBe(true);

    // 4) a non-JSON line is rejected, not a crash
    child.stdin!.write("this is not json\n");
    const bad = JSON.parse(await readline(child, 10_000)) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("json");

    // 5) bye exits cleanly (code 0)
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    child.stdin!.write(JSON.stringify({ op: "bye" }) + "\n");
    child.stdin!.end();
    expect(await exited).toBe(0);
  }, 180_000);
});
