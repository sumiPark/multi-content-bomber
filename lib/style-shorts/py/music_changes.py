"""배경음악이 바뀌는 시각을 찾는다(스타일 쇼츠 레퍼런스 분석, 2026-11-20 사용자 결정).

쓰는 법: python music_changes.py <영상 경로> [--debug]
표준 출력에 JSON 한 줄: {"changes": [초, ...], "channel": "side" | "mix"}. 실패하면 종료 코드 1과 오류 한 줄.

말소리는 대개 가운데(양쪽 같은 소리)에 있고 음악은 좌우로 퍼져 있어, 왼쪽 - 오른쪽(옆 채널)에는 말이 거의 빠지고 음악이 남는다.
옆 채널의 음색(MFCC)이 3초 앞뒤로 크게 달라지는 곳을 곡 · 구간이 바뀐 곳으로 본다(자기 유사 행렬 + 체커보드 커널).
화음(chroma)은 한 곡 안에서도 코드가 바뀌어 봉우리가 많아 쓰지 않는다. 2026-11-20 실측:
- 사람 편집 해물모듬: 14.3 · 44.8초(스펙트로그램으로 확인한 곡 바뀜)만 평소의 3배를 넘었다(4.2 · 3.3배)
- 사람 편집 추황배: 3.7(음악 시작) · 18.3 · 34.2 · 47.0초(음악 끝) — 그림과 맞음
- 한 곡만 쓴 우리 완성본 2편: 가장 큰 봉우리 2.4 · 2.9배라 0번
- 사람 편집 블루베리의 17.5초 짧은 끊김 뒤 바뀜은 못 잡는다(없는 변화를 지어내지 않게 기준을 보수적으로 둔다)
옆 채널이 너무 작으면(음악도 가운데에 섞인 영상) 전체 소리로 재고 channel을 mix로 적는다 — 말소리 때문에 덜 정확하다.
"""
import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 2205  # 0.1초
# 체커보드 커널 반쪽 길이(프레임) — 앞뒤 3초를 비교한다
HALF = 30
# 특징을 고르게 펴는 길이(프레임) — 말 · 효과음 한 순간에 흔들리지 않게 1초
SMOOTH = 10
# 바뀐 곳 사이 최소 간격(초) · 처음 · 끝에서 이 안은 보지 않는다(커널이 반만 걸린다)
MIN_GAP = 4.0
EDGE = 2.0
# 노벨티가 영상 안 평소 값(양수 중앙값)의 이 배수를 넘어야 바뀐 곳으로 본다
RATIO = 3.0
# 옆 채널이 가운데보다 이만큼(dB) 넘게 작으면 음악이 가운데에 섞였다고 본다
SIDE_MIN_DB = -28.0


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)
    return (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2


def rms_db(y):
    return float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-9))


def novelty(feat):
    """feat: (d, n) 특징. 대각선을 따라 체커보드 커널을 밀어 노벨티 곡선을 만든다."""
    n = feat.shape[1]
    norm = feat / (np.linalg.norm(feat, axis=0, keepdims=True) + 1e-9)
    ssm = norm.T @ norm
    g = np.outer(np.hanning(2 * HALF), np.hanning(2 * HALF))
    sign = np.ones((2 * HALF, 2 * HALF))
    sign[:HALF, HALF:] = -1
    sign[HALF:, :HALF] = -1
    kernel = g * sign
    kernel /= np.abs(kernel).sum()
    out = np.zeros(n)
    for i in range(HALF, n - HALF):
        out[i] = np.sum(ssm[i - HALF:i + HALF, i - HALF:i + HALF] * kernel)
    return out


def main():
    if len(sys.argv) < 2:
        print("music_changes.py: 영상 경로가 필요해요", file=sys.stderr)
        return 1
    import librosa

    mid, side = decode(sys.argv[1])
    duration = len(mid) / SR
    side_db = rms_db(side) - rms_db(mid)
    use_side = side_db > SIDE_MIN_DB
    y = side if use_side else mid

    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=13)[1:]
    feat = (mfcc - mfcc.mean(axis=1, keepdims=True)) / (mfcc.std(axis=1, keepdims=True) + 1e-9)
    feat = np.apply_along_axis(lambda r: np.convolve(r, np.ones(SMOOTH) / SMOOTH, mode="same"), 1, feat)
    nov = novelty(feat)

    t = np.arange(len(nov)) * HOP / SR
    inside = (t > EDGE) & (t < duration - EDGE)
    vals = nov[inside & (nov > 0)]
    med = float(np.median(vals)) if vals.size else 0.0
    peak = [i for i in range(1, len(nov) - 1) if inside[i] and nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1]]
    peak.sort(key=lambda i: -nov[i])
    changes = []
    if med > 0:
        for i in peak:
            if nov[i] < RATIO * med:
                break
            if all(abs(t[i] - c) >= MIN_GAP for c in changes):
                changes.append(round(float(t[i]), 1))

    out = {"changes": sorted(changes), "channel": "side" if use_side else "mix"}
    if "--debug" in sys.argv:
        out["debug"] = {"top": [(round(float(t[i]), 1), round(float(nov[i] / med), 1)) for i in peak[:6]] if med > 0 else [], "sideDb": round(side_db, 1)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # 부르는 쪽(Node)이 이 줄을 경고로 남긴다
        print(f"music_changes.py: {type(err).__name__}: {err}"[:300], file=sys.stderr)
        sys.exit(1)
