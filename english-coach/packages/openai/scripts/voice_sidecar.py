#!/usr/bin/env python3
"""English Coach local-voice sidecar.

A resident process speaking JSON lines over stdio. The parent (Node) sends one
op per line on stdin and reads one JSON response per line from stdout.

    parent -> child : {"id":1,"op":"stt","audio":"<hex pcm16 16 kHz>"}
                       {"id":2,"op":"tts","text":"..."}
                       {"id":3,"op":"ping"}
                       {"op":"bye"}
    child  -> parent: {"ready":true}                              (once, after Whisper loads)
                       {"ok":true,"id":1,"text":"..."}           (stt result)
                       {"ok":true,"id":2,"audio":"<hex>","sampleRate":22050}  (tts result)
                       {"ok":true,"id":3}                        (ping)
                       {"ok":false,"id":<n>,"error":"..."}       (any failure)

Whisper is loaded eagerly (it backs the STT path). Piper is loaded LAZILY on
the first ``tts`` op and its voice auto-downloads there, so a cold start — or a
session that never needs speech output — is never blocked by a ~60 MB voice
download. Every line is flushed immediately: Python stdout is block-buffered on
a pipe, and a buffered ``ready`` line would make the parent's startup handshake
time out.

Whisper runs capped to suppress hallucination-on-silence: ``beam_size=1``,
``condition_on_previous_text=False``, a ``no_speech_threshold``, and a hard
``max_new_tokens``.
"""
import json
import os
import sys


def _say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _load_whisper(model_name):
    from faster_whisper import WhisperModel
    # device=cpu + int8: this is a CPU box (no GPU). int8 is the spec's quantized
    # model and ~4x smaller/faster than fp on CPU.
    return WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4)


def _load_piper(voice, data_dir):
    from pathlib import Path
    from piper import PiperVoice

    pdir = Path(data_dir)
    pdir.mkdir(parents=True, exist_ok=True)  # download_voice() does not mkdir
    model_path = pdir / f"{voice}.onnx"
    if not model_path.exists():
        from piper.download_voices import download_voice
        download_voice(voice, pdir)  # writes {voice}.onnx + {voice}.onnx.json
    return PiperVoice.load(str(model_path))  # finds {voice}.onnx.json automatically


def _do_stt(model, audio_hex):
    import numpy as np

    pcm = bytes.fromhex(audio_hex)
    # float32 in [-1, 1] at 16 kHz. transcribe() accepts an ndarray directly
    # (it skips decode_audio), so no temp wav file is needed.
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _info = model.transcribe(
        samples,
        language="en",
        beam_size=1,
        condition_on_previous_text=False,
        no_speech_threshold=0.5,
        hallucination_silence_threshold=0.5,
        max_new_tokens=400,
    )
    return " ".join(seg.text.strip() for seg in segments).strip()


def main():
    whisper_model = os.environ.get("WHISPER_MODEL", "small")
    piper_voice = os.environ.get("PIPER_VOICE", "en_US-ryan-medium")
    piper_dir = os.environ.get("PIPER_DATA_DIR", "data/piper")

    model = _load_whisper(whisper_model)  # may raise -> top handler -> fatal line

    _say({"ready": True})  # Whisper is up; Piper loads on first use.
    piper = None

    while True:
        line = sys.stdin.readline()
        if not line:  # stdin closed -> parent is gone
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            _say({"ok": False, "error": "bad json"})
            continue

        op = req.get("op")
        if op == "bye":
            break
        if op == "ping":
            _say({"ok": True, "id": req.get("id")})
            continue
        if op == "stt":
            try:
                _say({"ok": True, "id": req.get("id"), "text": _do_stt(model, req["audio"])})
            except Exception as e:  # noqa: BLE001 - report, keep serving
                _say({"ok": False, "id": req.get("id"), "error": f"stt: {e!r}"})
        elif op == "tts":
            try:
                if piper is None:
                    piper = _load_piper(piper_voice, piper_dir)
                from piper import SynthesisConfig

                pcm = bytearray()
                sample_rate = 22050
                for chunk in piper.synthesize(req["text"], SynthesisConfig()):
                    sample_rate = chunk.sample_rate
                    pcm.extend(chunk.audio_int16_bytes)
                _say({"ok": True, "id": req.get("id"), "audio": bytes(pcm).hex(), "sampleRate": sample_rate})
            except Exception as e:  # noqa: BLE001
                _say({"ok": False, "id": req.get("id"), "error": f"tts: {e!r}"})
        else:
            _say({"ok": False, "id": req.get("id"), "error": f"unknown op: {op!r}"})

    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - a startup crash must surface, not hang the parent
        try:
            _say({"ok": False, "error": f"fatal: {e!r}"})
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
