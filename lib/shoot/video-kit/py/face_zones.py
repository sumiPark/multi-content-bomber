# 프레임마다 얼굴이 글자 자리(위 · 가운데 · 아래)에 얼마나 걸치는지 잰다. 입력: 프레임 경로 JSON 배열 파일.
# 값은 그 자리에 가장 많이 걸친 얼굴의 세로 비율(0~1)이다. 얼굴이 없으면 0.
# 스타일 쇼츠가 자막을 몸 위에는 두되 얼굴만 피하는 데 쓴다. 프레임을 네트워크로 보내지 않는다.
# 모델은 OpenCV YuNet(models/README.md). Haar 방식은 2026-11-20 실측에서 모자 · 안경 쓴 얼굴을 놓치고 과일을 얼굴로 잡아 쓰지 않는다.
import json
import os
import sys

import cv2

ZONES = {"top": (170, 600), "mid": (660, 1060), "lower": (1100, 1480)}
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")
# 화면을 채운 큰 얼굴도 잡히게 줄여서 본다(YuNet은 300px 안팎까지의 얼굴에 맞춰져 있다)
W, H = 360, 640
MIN_SCORE = 0.6


def main():
    frames = json.load(open(sys.argv[1], encoding="utf-8"))
    detector = cv2.FaceDetectorYN.create(MODEL, "", (W, H), MIN_SCORE, 0.3, 50)
    out = []
    for path in frames:
        image = cv2.imread(path)
        if image is None:
            raise RuntimeError(f"프레임을 읽지 못함: {path}")
        _, faces = detector.detect(cv2.resize(image, (W, H)))
        cover = {name: 0.0 for name in ZONES}
        for f in faces if faces is not None else []:
            top = float(f[1]) * 1920 / H
            bottom = float(f[1] + f[3]) * 1920 / H
            for name, (a, b) in ZONES.items():
                inside = max(0.0, min(bottom, b) - max(top, a))
                cover[name] = max(cover[name], round(inside / max(1.0, bottom - top), 3))
        out.append(cover)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
