"""Render assets/narration/cues.json to assets/narration/<key>.mp3 with a neural voice, and record
when each sentence starts (assets/narration/timings.json) so the page can caption the line being spoken.

Keys: <lesson>-0 (overview), <lesson>-<step>-<event> (spoken while that animation event plays),
<lesson>-done (recap). Event indexes follow each step's event list in the lesson data.

    pip install edge-tts
    python tools/build_narration.py            # only clips that are missing or have no timings
    python tools/build_narration.py --force    # re-render everything (after editing text)
"""
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "-4%"
OUT = Path(__file__).resolve().parent.parent / "assets" / "narration"
TIMINGS = OUT / "timings.json"


async def render(key: str, text: str, gate: asyncio.Semaphore, timings: dict) -> None:
    async with gate:
        target = OUT / f"{key}.mp3"
        for _ in range(4):
            try:
                audio, lines = bytearray(), []
                async for chunk in edge_tts.Communicate(text, VOICE, rate=RATE).stream():
                    if chunk["type"] == "audio":
                        audio.extend(chunk["data"])
                    elif chunk["type"] == "SentenceBoundary":
                        lines.append([round(chunk["offset"] / 1e7, 2), chunk["text"]])
                if not audio:
                    raise RuntimeError("empty audio")
                target.write_bytes(audio)
                timings[key] = lines or [[0, text]]
                print("ok  ", key, flush=True)
                return
            except Exception as err:  # transient errors from the TTS service
                print("retry", key, err, flush=True)
                await asyncio.sleep(3)
        raise SystemExit(f"failed: {key}")


async def main(force: bool) -> None:
    cues = json.loads((OUT / "cues.json").read_text(encoding="utf-8"))
    timings = json.loads(TIMINGS.read_text(encoding="utf-8")) if TIMINGS.exists() and not force else {}
    timings = {k: v for k, v in timings.items() if k in cues}
    for stale in OUT.glob("*.mp3"):
        if stale.stem not in cues:
            stale.unlink()
    todo = {k: v for k, v in cues.items() if force or k not in timings or not (OUT / f"{k}.mp3").exists()}
    gate = asyncio.Semaphore(6)
    try:
        await asyncio.gather(*(render(k, v, gate, timings) for k, v in todo.items()))
    finally:
        ordered = {k: timings[k] for k in cues if k in timings}
        TIMINGS.write_text(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"done: {len(todo)} rendered, {len(cues)} total")


if __name__ == "__main__":
    asyncio.run(main("--force" in sys.argv))
