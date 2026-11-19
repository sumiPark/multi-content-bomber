# 스타일 쇼츠 주석 수정(3단계) — 지난 완성본의 주석 시각 프레임에 번호 동그라미를 그린다(러너 전용).
# 편집 에이전트가 "여기"가 어디인지 알게 한다. 입력: jobs.json [{ src, out, no, x, y, label }]
# x · y는 화면 비율(0~1)이고, 둘 다 없으면 동그라미 없이 번호와 시각만 적는다.
# 출력(마지막 줄): [{ out, ok, error }]
import json
import sys

from PIL import Image, ImageDraw, ImageFont

RING = (255, 214, 0)
SHADOW = (0, 0, 0)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow 10.1 이전
        return ImageFont.load_default()


def mark(job):
    img = Image.open(job["src"]).convert("RGB")
    w, h = img.size
    d = ImageDraw.Draw(img)
    no = str(job["no"])
    big = font(max(18, w // 14))
    small = font(max(14, w // 22))
    x, y = job.get("x"), job.get("y")
    if x is not None and y is not None:
        cx, cy = x * w, y * h
        r = w * 0.09
        # 어두운 테두리 위에 노란 고리 — 밝은 화면에서도 보이게
        d.ellipse([cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], outline=SHADOW, width=max(9, w // 60))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=max(5, w // 100))
        bx, by = cx + r * 0.7, cy - r * 1.1
        br = max(14, w // 26)
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=RING, outline=SHADOW, width=2)
        d.text((bx, by), no, font=big, fill=SHADOW, anchor="mm")
    label = job.get("label") or f"#{no}"
    tb = d.textbbox((0, 0), label, font=small)
    pad = 8
    d.rectangle([0, 0, tb[2] - tb[0] + pad * 2, tb[3] - tb[1] + pad * 2], fill=SHADOW)
    d.text((pad - tb[0], pad - tb[1]), label, font=small, fill=RING)
    img.save(job["out"], quality=82)


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf-8"))
    out = []
    for job in jobs:
        try:
            mark(job)
            out.append({"out": job["out"], "ok": True, "error": None})
        except Exception as e:  # 한 장이 실패해도 나머지는 그린다
            out.append({"out": job["out"], "ok": False, "error": str(e)[:200]})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
