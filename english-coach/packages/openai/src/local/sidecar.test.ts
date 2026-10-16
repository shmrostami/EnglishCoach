import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSidecar } from "./sidecar.js";

/** The fake sidecar speaks the exact JSON-line protocol of voice_sidecar.py. */
const FAKE = `
let buf = "";
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.op === "stt") process.stdout.write(JSON.stringify({ ok: true, id: req.id, text: "FAKE TEXT" }) + "\\n");
    else if (req.op === "tts") process.stdout.write(JSON.stringify({ ok: true, id: req.id, audio: "0011223344556677", sampleRate: 22050 }) + "\\n");
    else if (req.op === "tts_fail") process.stdout.write(JSON.stringify({ ok: false, id: req.id, error: "boom" }) + "\\n");
    else if (req.op === "slow") setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, id: req.id, text: "slow" }) + "\\n"), 5000);
    else if (req.op === "kill") process.exit(7);
    else if (req.op === "bye") process.exit(0);
  }
});
`;

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ec-sidecar-"));
  script = join(dir, "fake_sidecar.mjs");
  writeFileSync(script, FAKE, "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(over: Partial<ConstructorParameters<typeof VoiceSidecar>[0]> = {}): VoiceSidecar {
  return new VoiceSidecar({ python: process.execPath, script, ...over });
}

describe("VoiceSidecar", () => {
  it("handshakes ready, pairs id'd requests, and exits cleanly on close", async () => {
    const s = make();
    await s.ready();
    expect((await s.request("stt", { audio: "00" })).ok).toBe(true);
    const tts = await s.request("tts", { text: "hi" });
    expect(tts.ok).toBe(true);
    // "ok" is true on every variant, so a bare `if (tts.ok)` doesn't narrow;
    // the `in` check does, without touching the pinned SidecarResponse type.
    if (tts.ok && "audio" in tts) {
      expect(tts.audio).toBeInstanceOf(Buffer);
      expect(tts.sampleRate).toBe(22050);
    }
    s.close();
    await new Promise((r) => setTimeout(r, 100)); // let the kill land
  });

  it("rejects a request with 'sidecar closed' after close() (Review Focus 4: a new session can't revive a torn-down sidecar)", async () => {
    const s = make();
    await s.ready();
    s.close();
    await expect(s.request("stt", { audio: "00" })).rejects.toThrow("sidecar closed");
    s.close(); // idempotent: no throw, no second kill
  });

  it("pre-ready exit rejects ready() with stt_unavailable (Review Focus 1: visible FAILED, not a hang)", async () => {
    const dying = join(dir, "dying_sidecar.mjs");
    writeFileSync(dying, "process.stdout.write(JSON.stringify({ ok: false, error: 'ModuleNotFoundError: No module named \\'faster_whisper\\'' }) + '\\n');\nprocess.exit(1);\n", "utf8");
    const s = make({ script: dying });
    await expect(s.ready()).rejects.toThrow("stt_unavailable");
    s.close();
  });

  it("a post-ready exit fires onCrash exactly once with the exit code (Review Focus 3: exactly one voice_engine_lost)", async () => {
    const s = make();
    await s.ready();
    const codes: (number | null)[] = [];
    s.onCrash((code) => codes.push(code));
    await s.request("stt", { audio: "00" }); // the child is alive here
    await new Promise<void>((resolve) => {
      // drive the child to self-kill over the wire; the kill request itself
      // rejects with 'sidecar died' when the exit lands. Swallow that expected
      // rejection on the (already-resolved) chain so it isn't unhandled — only
      // the crash-code assertions below are the point.
      const p = s.request("tts", { text: "", op: "kill" });
      void p.catch(() => {}).finally(() => setTimeout(resolve, 100));
    });
    await new Promise((r) => setTimeout(r, 100)); // give the exit event a tick to deliver
    expect(codes).toHaveLength(1); // exactly once — the guard is the point
    expect(codes[0]).toBe(7); // the fake's self-chosen exit code — deterministic across platforms (signal-kill codes are not)
  });

  it("a missing interpreter rejects ready() with stt_unavailable (Review Focus 1: python absent from the box)", async () => {
    const s = make({ python: "definitely-not-a-real-interpreter-xyz" });
    await expect(s.ready()).rejects.toThrow("stt_unavailable");
  });

  it("a request in flight when the child dies rejects with stt_unavailable (no orphaned waiter)", async () => {
    const s = make({ requestTimeoutMs: 5_000 });
    await s.ready();
    const p = s.request("tts", { text: "", op: "kill" }); // the child dies while this is outstanding
    await expect(p).rejects.toThrow("stt_unavailable: sidecar died");
  });

  it("a request outliving its timeout rejects with 'sidecar timeout' (and later requests still reject cleanly)", async () => {
    const s = make({ requestTimeoutMs: 300 });
    await s.ready();
    await expect(s.request("tts", { text: "", op: "slow" })).rejects.toThrow("sidecar timeout after 300 ms");
    // the timed-out op's (late) response must not be delivered to a later request
    await new Promise((r) => setTimeout(r, 5_300));
    await expect(s.request("stt", { audio: "00" })).resolves.toMatchObject({ ok: true, text: "FAKE TEXT" });
    s.close();
  }, 10_000); // the 5.3 s late-response wait deliberately outlives the default 5 s testTimeout
});
