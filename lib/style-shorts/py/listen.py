"""레퍼런스 영상의 소리 분석 — earshot timeline에서 스타일 카드에 필요한 값만 꺼낸다(스타일 쇼츠).

쓰는 법: python listen.py <영상 경로>
표준 출력에 JSON 한 줄(lib/style-shorts/card.ts의 SoundAnalysis)을 쓴다. 실패하면 종료 코드 1과 오류 한 줄.

소리를 귀로 듣는 게 아니라 earshot의 측정값과 태그(CLAP 추측)다. 태그는 힌트일 뿐이라
배경 위로 11dB 넘게 튀어나온 사건만 효과음으로 센다(earshot 기준 '강한 강세').

earshot은 한 번 부를 때 이름(태그)을 붙이는 사건 수가 정해져 있다(detail low = 12개). 이름을 다 쓴 영상은
효과음이 더 있어도 세지 못하니 sfxCapped로 "최소값"이라고 알린다. 구간을 나눠 이름을 더 붙여 보면
말소리 · 음악 박자도 효과음으로 잡혀(2026-11-20 실측: 효과음 5개인 영상을 24개로 셈) 쓰지 않는다.
"""
import json
import statistics
import sys

ACCENT_DB = 11.0
MAX_EVENTS = 40
# detail low에서 earshot이 이름을 붙이는 사건 수
TAG_BUDGET = 12
# 이보다 가까운 두 사건은 같은 효과음으로 본다(팝 두 겹 등)
SAME_EVENT_SEC = 0.12
# 끝에서 이 안에 음악이 끊긴 곳(stop-down)이 있으면 끝맺음 직전에 음악을 멈춘 것으로 본다
END_DROP_SEC = 4.0
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

    tagged = [e for e in r.get("events", []) if e.get("kind")]

    events = []
    kinds = {}
    for e in sorted(tagged, key=lambda e: float(e["t"])):
        kind = e.get("kind")
        if kind in NOT_SFX:
            continue
        over = float(e.get("prominence_db") or 0)
        if over < ACCENT_DB:
            continue
        at = float(e["t"])
        if events and at - events[-1]["t"] < SAME_EVENT_SEC:
            continue
        kinds[kind] = kinds.get(kind, 0) + 1
        tag = (e.get("tags") or [{}])[0].get("tag", "")
        events.append({"t": round(at, 2), "kind": kind, "tag": tag, "overBedDb": round(over, 1)})

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
    loudness = r.get("loudness") or {}
    stats = (((r.get("sync") or {}).get("cuts") or {}).get("stats")) or {}
    gaps = [g for g in loudness.get("silences") or [] if g.get("kind") == "drop"]

    out = {
        "sections": sections,
        "events": events[:MAX_EVENTS],
        "sfxPer10s": round(len(events) / duration * 10, 1),
        # 이름 붙일 수 있는 사건을 다 썼다 — sfxPer10s는 최소값이다
        "sfxCapped": len(tagged) >= TAG_BUDGET,
        "kinds": kinds,
        # 효과음이 바닥(바로 앞 소리)보다 얼마나 크게 들리는지 — 중앙값 dB
        "sfxOverBedDb": round(statistics.median([e["overBedDb"] for e in events]), 1) if events else None,
        "tempo": round(float(music["tempo"])) if steady and music.get("tempo") else None,
        "steadyBeat": steady,
        "loudnessLufs": loudness.get("integrated_lufs"),
        "truePeakDb": loudness.get("true_peak_dbtp"),
        # 끝맺음 직전에 소리를 잠깐 끊었는지(stop-down)
        "endDrop": any(float(g.get("start") or 0) >= duration - END_DROP_SEC for g in gaps),
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
