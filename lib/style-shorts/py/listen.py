"""레퍼런스 영상의 소리 분석 — earshot timeline에서 스타일 카드에 필요한 값만 꺼낸다(스타일 쇼츠).

쓰는 법: python listen.py <영상 경로>
표준 출력에 JSON 한 줄(lib/style-shorts/card.ts의 SoundAnalysis)을 쓴다. 실패하면 종료 코드 1과 오류 한 줄.

소리를 귀로 듣는 게 아니라 earshot의 측정값과 태그(CLAP 추측)다. 태그는 힌트일 뿐이라
배경 위로 11dB 넘게 튀어나온 사건만 효과음으로 센다(earshot 기준 '강한 강세').
"""
import json
import sys

ACCENT_DB = 11.0
MAX_EVENTS = 40
# 말소리 · 무음은 효과음으로 세지 않는다
NOT_SFX = {"VOICE", "GAP", "MUSIC"}


def top(tags, n=2, min_z=1.5):
    return [t["tag"] for t in (tags or [])[:n] if t.get("z", 0) >= min_z]


def main():
    if len(sys.argv) < 2:
        print("listen.py: 영상 경로가 필요해요", file=sys.stderr)
        return 1
    path = sys.argv[1]
    from earshot import api

    r = api.timeline(path, video=path, detail="low")
    duration = float(r.get("duration") or 0) or 1.0

    events = []
    kinds = {}
    for e in r.get("events", []):
        kind = e.get("kind")
        if not kind or kind in NOT_SFX:
            continue
        over = float(e.get("prominence_db") or 0)
        if over < ACCENT_DB:
            continue
        kinds[kind] = kinds.get(kind, 0) + 1
        tag = (e.get("tags") or [{}])[0].get("tag", "")
        events.append({"t": round(float(e["t"]), 2), "kind": kind, "tag": tag, "overBedDb": round(over, 1)})

    sections = []
    has_music = False
    has_voice = False
    for s in r.get("sections", []):
        genre = top(s.get("music_genre"))
        mood = top(s.get("music_mood"))
        if any(t.get("z", 0) >= 2.0 for t in (s.get("music_genre") or [])[:1]):
            has_music = True
        if any(t.get("z", 0) >= 2.0 for t in (s.get("voice") or [])[:1]):
            has_voice = True
        sections.append({
            "start": s.get("start"),
            "end": s.get("end"),
            "genre": genre,
            "mood": mood,
            "instruments": top(s.get("instruments")),
        })

    music = r.get("music") or {}
    steady = float(music.get("pulse_clarity") or 0) >= 0.15
    loud = (r.get("loudness") or {}).get("integrated_lufs")
    stats = (((r.get("sync") or {}).get("cuts") or {}).get("stats")) or {}

    out = {
        "sections": sections,
        "events": events[:MAX_EVENTS],
        "sfxPer10s": round(len(events) / duration * 10, 1),
        "kinds": kinds,
        "tempo": round(float(music["tempo"])) if steady and music.get("tempo") else None,
        "steadyBeat": steady,
        "loudnessLufs": loud,
        "cutsWithSound": stats.get("hit_within_100ms"),
        "hasMusic": has_music,
        "hasVoice": has_voice,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # 부르는 쪽(Node)이 이 줄을 경고로 남긴다
        print(f"listen.py: {type(err).__name__}: {err}"[:300], file=sys.stderr)
        sys.exit(1)
