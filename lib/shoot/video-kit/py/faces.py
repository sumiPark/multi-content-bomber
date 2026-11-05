# 프레임마다 얼굴이 보이는지 잰다. AI 판단과 별개로 코드가 한 번 더 거르는 용도다. 입력: 프레임 경로 JSON 배열 파일.
import json
import os
import sys

import cv2


def main():
    frames = json.load(open(sys.argv[1], encoding="utf-8"))
    cascades = [cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, n)) for n in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")]
    out = []
    for path in frames:
        image = cv2.imread(path)
        if image is None:
            raise RuntimeError(f"프레임을 읽지 못함: {path}")
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        out.append(sum(len(c.detectMultiScale(gray, 1.1, 6, minSize=(60, 60))) for c in cascades))
    print(json.dumps(out))


if __name__ == "__main__":
    main()
