# 멈춘 이미지에 코드로 움직임을 넣어 세로 영상으로 만든다. 입력: 이미지 경로, 결과 경로, 길이(초), liquid|solid, 시드.
# 카메라가 천천히 밀어 들어가고, 가까운 곳이 조금 더 움직이며, liquid는 일렁임과 떠오르는 방울이 더해진다.
# 빛은 빈 배경을 비추면 기둥처럼 보여 세부가 있는 곳의 밝은 부분에만 얹는다(2026-11-05 시험).
import json
import os
import subprocess
import sys

import cv2
import numpy as np

W, H, FPS = 1080, 1920, 30
STYLES = {
    "liquid": {"flow": 4.5, "bubbles": 26, "sweep": 0.08},
    "solid": {"flow": 1.2, "bubbles": 0, "sweep": 0.14},
}


def cover(img):
    h, w = img.shape[:2]
    scale = max(W / w, H / h)
    img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_CUBIC)
    h, w = img.shape[:2]
    x, y = (w - W) // 2, (h - H) // 2
    return img[y : y + H, x : x + W]


def make_bubbles(count, seed):
    rng = np.random.default_rng(seed)
    return [
        {
            "x": rng.uniform(40, W - 40),
            "y": rng.uniform(H * 0.28, H * 1.02),
            "r": float(rng.choice([4, 5, 6, 8, 10, 14], p=[0.25, 0.25, 0.2, 0.15, 0.1, 0.05])),
            "rise": rng.uniform(70, 240),
            "wob": rng.uniform(3, 12),
            "phase": rng.uniform(0, 6.28),
        }
        for _ in range(count)
    ]


def draw_bubbles(bubbles, t):
    layer = np.zeros((H, W, 3), np.float32)
    shift = 4
    k = 1 << shift
    for b in bubbles:
        x = b["x"] + b["wob"] * np.sin(b["phase"] + t * 5.0)
        y = b["y"] - b["rise"] * t
        cv2.circle(layer, (int(x * k), int(y * k)), int(b["r"] * k), (0.42, 0.42, 0.42), max(1, int(b["r"] * 0.22)), cv2.LINE_AA, shift)
        spot = (int((x - b["r"] * 0.35) * k), int((y - b["r"] * 0.35) * k))
        cv2.circle(layer, spot, int(max(1, b["r"] * 0.22) * k), (0.75, 0.75, 0.75), -1, cv2.LINE_AA, shift)
    return cv2.GaussianBlur(layer, (0, 0), 0.8)


def main():
    src, out, seconds, motion, seed = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], int(sys.argv[5])
    style = STYLES.get(motion, STYLES["solid"])
    frames = max(2, round(seconds * FPS))
    raw = cv2.imread(src)
    if raw is None:
        raise SystemExit(f"이미지를 읽지 못함: {src}")
    img = cover(raw)
    base = img.astype(np.float32) / 255.0
    X, Y = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    edges = np.abs(cv2.Laplacian(cv2.GaussianBlur(gray, (0, 0), 2), cv2.CV_32F))
    # 아래쪽과 선명한 곳을 가깝게 본다. 부드러운 값이라 경계가 찢어지지 않는다
    far = cv2.GaussianBlur(edges, (0, 0), 70)
    far = far / max(float(far.max()), 1e-6)
    depth = cv2.GaussianBlur(np.clip(0.65 * (Y / H) + 0.6 * far, 0, 1), (0, 0), 50)
    # 세부가 있는 곳의 밝은 부분만 빛을 받는다
    near = cv2.GaussianBlur(edges, (0, 0), 25)
    near = np.clip(near / max(float(np.percentile(near, 90)), 1e-6), 0, 1)
    shine = near * np.clip((gray - 0.45) / 0.55, 0, 1) ** 1.5
    bubbles = make_bubbles(style["bubbles"], seed)

    cmd = [
        os.environ.get("FFMPEG_PATH") or "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", out,
    ]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cx, cy = W / 2, H * 0.58
    for f in range(frames):
        t = f / (frames - 1)
        scale = 1.02 + 0.075 * t
        dx = style["flow"] * (np.sin(2 * np.pi * (Y / 430 + 0.55 * t)) + 0.5 * np.sin(2 * np.pi * (Y / 190 - 0.8 * t + X / 900)))
        dy = style["flow"] * (np.sin(2 * np.pi * (X / 360 + 0.45 * t + 0.3)) + 0.5 * np.sin(2 * np.pi * (X / 170 + 0.7 * t + Y / 1100)))
        mx = cx + (X - cx) / scale + dx * depth + depth * 22 * (t - 0.5)
        my = cy + (Y - cy) / scale + dy * depth - depth * 34 * (t - 0.5)
        frame = cv2.remap(base, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        band = np.exp(-(((X / W + Y / H * 0.55) / 1.55 - (-0.25 + 1.5 * t)) / 0.16) ** 2)
        light = cv2.remap(shine, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        frame = frame + (style["sweep"] * band * light)[..., None]
        if bubbles:
            frame = 1 - (1 - frame) * (1 - draw_bubbles(bubbles, t))
        enc.stdin.write((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        raise SystemExit("인코딩 실패")
    print(json.dumps({"seconds": frames / FPS}))


if __name__ == "__main__":
    main()
