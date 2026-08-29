#!/usr/bin/env python3
"""
tools/transcribe-whisper.py

Standalone ASR transcription CLI using faster-whisper.

Usage:
  python3 tools/transcribe-whisper.py --audio /tmp/audio.mp3
"""

import argparse
import glob
import json
import os
import sys
import time
from pathlib import Path

def resolve_model_path(model_arg: str | None) -> str:
    if model_arg and Path(model_arg).is_dir():
        return str(Path(model_arg).resolve())
    
    # Check default huggingface cache snapshots
    cache_base = Path.home() / ".cache" / "huggingface" / "hub" / "models--Systran--faster-whisper-small" / "snapshots"
    if cache_base.is_dir():
        snapshots = list(cache_base.glob("*"))
        if snapshots:
            return str(snapshots[0])
            
    return model_arg or "Systran/faster-whisper-small"

def format_timestamp(seconds: float) -> str:
    millis = int(round((seconds - int(seconds)) * 1000))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def to_srt(segments) -> str:
    lines = []
    for i, seg in enumerate(segments, start=1):
        start_ts = format_timestamp(seg["start"])
        end_ts = format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start_ts} --> {end_ts}\n{text}\n")
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="Transcribe audio file using faster-whisper")
    parser.add_argument("--audio", required=True, help="Input audio file path")
    parser.add_argument("--model", default=None, help="Model name or local model directory")
    parser.add_argument("--output-dir", default=None, help="Directory to save transcript artifacts")
    parser.add_argument("--language", default="zh", help="Target language (zh, en, ja, etc.)")
    parser.add_argument("--compute-type", default="int8", help="Compute type (int8, float16, float32)")
    
    args = parser.parse_args()

    audio_path = Path(args.audio).resolve()
    if not audio_path.is_file():
        print(json.dumps({"status": "error", "error": f"Audio file not found: {args.audio}"}), file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir).resolve() if args.output_dir else audio_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    model_target = resolve_model_path(args.model)
    sys.stderr.write(f"[transcribe-whisper] Loading model: {model_target} ...\n")
    
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"status": "error", "error": "faster-whisper is not installed in python environment"}), file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    model = WhisperModel(
        model_target,
        device="cpu",
        compute_type=args.compute_type,
        cpu_threads=max(1, min(os.cpu_count() or 4, 8)),
        num_workers=1,
    )

    sys.stderr.write(f"[transcribe-whisper] Transcribing {audio_path.name} ...\n")
    segment_stream, info = model.transcribe(
        str(audio_path),
        language=args.language or None,
        beam_size=5,
        word_timestamps=False,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        temperature=0.0,
        initial_prompt="以下是简体中文普通话的准确逐字转录，请保留关键专有名词。",
    )

    segments = []
    for seg in segment_stream:
        text = seg.text.strip()
        if text:
            segments.append({
                "id": seg.id,
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            })

    duration = float(info.duration) if hasattr(info, 'duration') else round(time.time() - t0, 2)
    full_text = "\n".join(seg["text"] for seg in segments)
    srt_text = to_srt(segments)

    stem = audio_path.stem
    txt_file = output_dir / f"{stem}_transcript.txt"
    srt_file = output_dir / f"{stem}_transcript.srt"
    json_file = output_dir / f"{stem}_transcript.json"

    txt_file.write_text(full_text, encoding="utf-8")
    srt_file.write_text(srt_text, encoding="utf-8")
    json_file.write_text(json.dumps({
        "audio": str(audio_path),
        "durationSeconds": duration,
        "language": info.language,
        "segmentsCount": len(segments),
        "segments": segments
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    cost_seconds = round(time.time() - t0, 2)
    sys.stderr.write(f"[transcribe-whisper] Completed in {cost_seconds}s (audio duration: {duration}s)\n")

    result = {
        "status": "success",
        "audioFile": str(audio_path),
        "durationSeconds": duration,
        "language": info.language,
        "segmentsCount": len(segments),
        "textFile": str(txt_file),
        "srtFile": str(srt_file),
        "jsonFile": str(json_file),
        "preview": full_text[:400]
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
