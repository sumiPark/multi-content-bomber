"""배경음악 후보를 들어 보고 잰다(스타일 쇼츠 음악 고르기, 2026-11-20 사용자 결정).

쓰는 법: python music_fit.py <요청 JSON 경로>
요청: {"want": "upbeat playful funk music", "seconds": 45,
       "like": {"file": 경로, "start": 초} | null,
       "tracks": [{"id": "...", "file": 경로, "start": 초}]}
표준 출력에 JSON 한 줄: {"tracks": [{"id", "fit", "moods": {낱말: z}, "genres": [[낱말, z], ...],
                                   "loop": {"period": 초, "same": 0~1}, "like": 코사인 | null,
                                   "near": {다른 id: 코사인}} | {"id", "error"}]}
실패하면 종료 코드 1과 오류 한 줄.

제목 · 태그만 보고 고르면 분위기가 다른 곡이 섞인다(2026-11-20 실측: "upbeat playful funk"로 찾은 세 번째 곡이
재즈 · 잔잔한 쪽으로 들렸다). 그래서 실제로 쓸 구간(start부터 seconds초)을 earshot(CLAP)으로 재서
- fit: 원하는 분위기 글(want)과 얼마나 맞는지(z, 3 이상 뚜렷 · 2.5 그럴듯 · 2 미만 안 맞음)
- moods: earshot 분위기 낱말 16개 각각의 z — 부르는 쪽이 피할 분위기(잔잔 · 슬픔 등)와 견준다
- loop: 몇 초짜리 같은 소리가 되풀이되는지(same이 1에 가까울수록 똑같이 반복)
- like · near: 먼저 고른 곡 · 다른 후보와 소리가 얼마나 닮았는지(곡을 바꿀 때 결이 튀지 않게)
를 돌려준다. 고르는 규칙은 lib/style-shorts/music-fit.ts에 있다. 태그(z)는 추측이라 규칙은 여유를 두고 쓴다.
"""
import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 2205  # 0.1초
# 되풀이 주기를 찾는 범위(초). 한 마디(1초쯤)보다 짧은 박자 반복은 어느 곡에나 있어 보지 않는다
LOOP_MIN = 1.5
LOOP_MAX = 16.0
# 이보다 짧은 구간은 되풀이를 잴 수 없다
LOOP_NEED = 12.0
# 되풀이는 쓰는 길이와 상관없이 앞 45초로 잰다(짧은 구간으로는 8초 넘는 루프를 못 찾는다)
LOOP_SECONDS = 45.0


def decode(path, start, seconds):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(seconds), "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32)


def bands(y):
    """0.1초마다 32개 로그 대역 크기."""
    n = 2048
    if len(y) <= n:
        return np.zeros((0, 1))
    frames = np.array([y[i:i + n] * np.hanning(n) for i in range(0, len(y) - n, HOP)])
    mag = np.abs(np.fft.rfft(frames, axis=1))
    edges = np.unique(np.geomspace(2, mag.shape[1] - 1, 33).astype(int))
    return np.log1p(np.stack([mag[:, a:b].mean(axis=1) for a, b in zip(edges[:-1], edges[1:])], axis=1) * 100)


def loop(y):
    """가장 잘 겹치는 되풀이 주기(초)와 그 주기 · 두 배 · 세 배만큼 밀었을 때 닮은 정도의 평균.

    한 번만 겹치는 건 같은 마디가 한 번 더 나온 것일 수 있다. 여러 배수에서 계속 닮아야 '같은 소리 반복'이다.
    """
    f = bands(y)
    if len(f) < LOOP_NEED * 10:
        return None
    f = f - f.mean(axis=0)
    f = f / (np.linalg.norm(f, axis=1, keepdims=True) + 1e-9)

    def at(lag):
        return float(np.mean(np.sum(f[:-lag] * f[lag:], axis=1)))

    lags = range(int(LOOP_MIN * 10), min(int(LOOP_MAX * 10), len(f) // 3))
    if not lags:
        return None
    best = max(lags, key=at)
    multiples = [m * best for m in (1, 2, 3) if m * best < len(f) - 20]
    return {"period": round(best / 10, 1), "same": round(float(np.mean([at(m) for m in multiples])), 2)}


def unit(a):
    a = np.asarray(a, np.float32)
    return a / (np.linalg.norm(a) + 1e-9)


def main():
    if len(sys.argv) < 2:
        print("music_fit.py: 요청 JSON 경로가 필요해요", file=sys.stderr)
        return 1
    with open(sys.argv[1], encoding="utf-8") as fh:
        req = json.load(fh)
    from earshot import vocab

    v = vocab.get()
    moods = v.cats["music_mood"]
    seconds = float(req.get("seconds") or 45)
    want = req["want"]

    def embed(file, start):
        return vocab.embed_file(file, float(start or 0), float(start or 0) + seconds)

    like = None
    if req.get("like"):
        try:
            like = unit(embed(req["like"]["file"], req["like"].get("start")))
        except Exception:
            like = None

    out = []
    embs = {}
    for t in req["tracks"]:
        try:
            a = embed(t["file"], t.get("start"))
            row = v.scores(a[None], [want] + moods)[0]
            genres = v.top_terms(a, k=3, cats=("music_genre",))
            embs[t["id"]] = unit(a)
            out.append({
                "id": t["id"],
                "fit": row[0]["z"],
                "moods": {r["query"]: r["z"] for r in row[1:]},
                "genres": [[g[0], g[2]] for g in genres],
                "loop": loop(decode(t["file"], float(t.get("start") or 0), LOOP_SECONDS)),
                "like": round(float(embs[t["id"]] @ like), 3) if like is not None else None,
            })
        except Exception as err:
            out.append({"id": t["id"], "error": f"{type(err).__name__}: {err}"[:200]})
    for o in out:
        if o["id"] in embs:
            o["near"] = {k: round(float(embs[o["id"]] @ e), 3) for k, e in embs.items() if k != o["id"]}
    print(json.dumps({"tracks": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # 부르는 쪽(Node)이 이 줄을 경고로 남긴다
        print(f"music_fit.py: {type(err).__name__}: {err}"[:300], file=sys.stderr)
        sys.exit(1)
