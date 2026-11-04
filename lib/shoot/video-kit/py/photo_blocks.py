# 긴 상세페이지 이미지에서 사진 구간만 잘라 후보로 만든다. AI가 보기 전에 글자만 있는 구간을 뺀다.
# 글자 구간은 대부분 단색 바탕이라 한 줄의 픽셀이 같은 색에 몰린다. 사진 구간은 색이 흩어진다.
# 입력: 이미지 경로 JSON 배열 파일, 저장 폴더. 출력: 후보 목록과 번호를 적은 묶음 이미지.
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

W = 1000
MIN_H = 300
MAX_CANDIDATES = 36
THUMB = 240
COLS = 6


def flat_ratio(block):
    """줄마다 가장 많은 색의 비율(색을 뭉개서 잰다). block: (행, 열, 3)"""
    q = (block // 12).astype("int32")
    code = q[..., 0] * 441 + q[..., 1] * 21 + q[..., 2]
    out = np.zeros(code.shape[0])
    for i, row in enumerate(code):
        _, counts = np.unique(row, return_counts=True)
        out[i] = counts.max() / row.size
    return out


def spans(mask, min_len, gap):
    """참인 구간을 찾고, 짧은 틈은 잇는다."""
    out = []
    start = None
    last = None
    for i, v in enumerate(mask):
        if v:
            if start is None:
                start = i
            elif i - last > gap:
                out.append((start, last + 1))
                start = i
            last = i
    if start is not None:
        out.append((start, last + 1))
    return [(a, b) for a, b in out if b - a >= min_len]


def blocks_of(path):
    im = Image.open(path).convert("RGB")
    if im.width != W:
        im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
    # 대표 이미지처럼 짧은 이미지는 바탕이 단색이어도 제품 사진이다. 통째로 후보에 넣는다
    if im.height <= im.width * 1.4:
        return im, [(0, 0, im.width, im.height)]
    arr = np.asarray(im)
    # 속도를 위해 4줄마다 잰다
    rows = flat_ratio(arr[::4, ::2])
    photo = rows < 0.5
    out = []
    for a, b in spans(photo, MIN_H // 4, 8):
        top, bottom = a * 4, min(b * 4, im.height)
        cols = flat_ratio(arr[top:bottom:4, ::2].transpose(1, 0, 2))
        cs = spans(cols < 0.72, 40, 8)
        if not cs:
            continue
        left, right = min(c[0] for c in cs) * 2, max(c[1] for c in cs) * 2
        if right - left < 480:
            continue
        # 경계의 흰 줄이 남지 않게 조금 안쪽으로 자른다
        out.append((left + 6, top + 8, right - 6, bottom - 8))
    return im, out


def main():
    images = json.load(open(sys.argv[1], encoding="utf-8"))
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    cands = []
    for n, path in enumerate(images):
        try:
            im, boxes = blocks_of(path)
        except Exception as e:  # 깨진 이미지 하나로 전체를 멈추지 않는다
            print(f"건너뜀 {path}: {e}", file=sys.stderr)
            continue
        for (x0, y0, x1, y1) in boxes:
            if len(cands) >= MAX_CANDIDATES:
                break
            cid = f"p{len(cands) + 1}"
            f = os.path.join(out_dir, f"{cid}.jpg")
            im.crop((x0, y0, x1, y1)).save(f, quality=93)
            cands.append({"id": cid, "file": f, "image": n, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0})
    sheets = []
    per = COLS * 3
    for s in range(0, len(cands), per):
        part = cands[s : s + per]
        rows = (len(part) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * THUMB, rows * THUMB), (30, 30, 30))
        d = ImageDraw.Draw(sheet)
        for i, c in enumerate(part):
            t = Image.open(c["file"])
            t.thumbnail((THUMB - 8, THUMB - 8))
            x, y = (i % COLS) * THUMB + 4, (i // COLS) * THUMB + 4
            sheet.paste(t, (x, y))
            d.rectangle((x, y, x + 58, y + 24), fill=(0, 0, 0))
            d.text((x + 6, y + 6), c["id"], fill=(255, 220, 0))
        f = os.path.join(out_dir, f"sheet{len(sheets) + 1}.jpg")
        sheet.save(f, quality=84)
        sheets.append(f)
    print(json.dumps({"candidates": cands, "sheets": sheets}, ensure_ascii=False))


if __name__ == "__main__":
    main()
