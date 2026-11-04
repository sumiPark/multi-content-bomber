# 프레임마다 상품 · 사람이 글자 자리(위 · 가운데 · 아래)를 얼마나 차지하는지 잰다. 입력: 프레임 경로 JSON 배열 파일.
# 배경 제거 모델만 쓰고 네트워크로 프레임을 보내지 않는다. 모델은 처음 한 번 내려받는다.
import json
import sys

import numpy as np
from PIL import Image
from rembg import new_session, remove

ZONES = {"top": (170, 600), "mid": (660, 1060), "lower": (1100, 1480)}


def main():
    frames = json.load(open(sys.argv[1], encoding="utf-8"))
    session = new_session("isnet-general-use")
    out = []
    for path in frames:
        im = Image.open(path).convert("RGB")
        if im.size != (1080, 1920):
            im = im.resize((1080, 1920))
        alpha = np.array(remove(im, session=session))[:, :, 3] / 255.0
        out.append({name: round(float((alpha[a:b] > 0.5).mean()), 3) for name, (a, b) in ZONES.items()})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
