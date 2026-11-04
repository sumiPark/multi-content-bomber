# 영상의 한 구간에서 제품만 남긴 투명 영상을 만든다(글자가 제품 뒤로 들어가는 장면용).
# 입력: 영상, 시작(초), 길이(초), 저장 파일, 작업 폴더. 출력: 제품 평균 비율 JSON.
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image
from rembg import new_session, remove


def main():
    video, start, span, out, work = sys.argv[1:6]
    raw = os.path.join(work, "raw")
    cut = os.path.join(work, "cut")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(raw)
    os.makedirs(cut)
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", start, "-t", span, "-i", video, "-vf", "fps=30", os.path.join(raw, "f%04d.png")], check=True)
    session = new_session("isnet-general-use")
    ratios = []
    for name in sorted(os.listdir(raw)):
        arr = np.array(remove(Image.open(os.path.join(raw, name)).convert("RGB"), session=session))
        ratios.append(float((arr[:, :, 3] > 127).mean()))
        Image.fromarray(arr, "RGBA").save(os.path.join(cut, name))
    subprocess.run([ffmpeg, "-y", "-v", "error", "-framerate", "30", "-i", os.path.join(cut, "f%04d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "6M", "-auto-alt-ref", "0", out], check=True)
    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({"ratio": round(sum(ratios) / max(len(ratios), 1), 3)}))


if __name__ == "__main__":
    main()
