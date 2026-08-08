#!/usr/bin/env python3
"""Run one offline faster-whisper transcription and emit a stable JSON artifact."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile

from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--compute-type", default="int8")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audio = Path(args.audio).resolve(strict=True)
    model_path = Path(args.model).resolve(strict=True)
    output = Path(args.output).resolve()
    if not model_path.is_dir() or not (model_path / "model.bin").is_file():
        raise RuntimeError("faster-whisper model snapshot is incomplete")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type=args.compute_type,
        local_files_only=True,
        cpu_threads=max(1, min(os.cpu_count() or 4, 8)),
        num_workers=1,
    )
    segment_stream, info = model.transcribe(
        str(audio),
        language=args.language or None,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        temperature=0.0,
        initial_prompt="以下是简体中文普通话的准确逐字转录。",
    )
    segments = []
    for segment in segment_stream:
        segments.append(
            {
                "id": segment.id,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment.text.strip(),
                "avg_logprob": float(segment.avg_logprob),
                "no_speech_prob": float(segment.no_speech_prob),
                "compression_ratio": float(segment.compression_ratio),
                "words": [
                    {
                        "start": round(float(word.start), 3),
                        "end": round(float(word.end), 3),
                        "word": word.word,
                        "probability": float(word.probability),
                    }
                    for word in (segment.words or [])
                ],
            }
        )
    payload = {
        "schemaVersion": "agent.army/faster-whisper-transcript/v1",
        "text": "".join(segment["text"] for segment in segments).strip(),
        "language": info.language,
        "languageProbability": float(info.language_probability),
        "durationSeconds": float(info.duration),
        "durationAfterVadSeconds": float(info.duration_after_vad),
        "segments": segments,
    }
    fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_name, output)
        os.chmod(output, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
