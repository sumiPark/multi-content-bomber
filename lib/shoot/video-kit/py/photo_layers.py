# 제품 사진 한 장을 움직일 레이어로 나눈다. 포장 글자가 휘지 않게 레이어는 통째로만 움직이고, 깊이맵으로 픽셀을 밀지 않는다.
# 배경 제거: rembg isnet-general-use. 깊이: Depth Anything V2 Small(Apache-2.0)의 ONNX. 다른 크기는 비상업 라이선스라 쓰지 않는다.
# 흐린 복제 배경은 쓰지 않는다(2026-11-05 사용자 결정). 제품을 오려 코드로 만든 깨끗한 배경에 띄우거나, 제품이 많이 잘리지 않는 만큼 세로로 채운다.
# 출력 모드 float(제품을 띄움) / aligned(제품과 배경 분리) / depth(먼 쪽 · 가까운 쪽) / push(사진 전체) / unfit(제품이 잘려 쓰지 않음, 레이어 없음).
import json
import os
import sys
import urllib.request

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter
from rembg import new_session, remove

W, H = 1080, 1920
# 세로로 채웠을 때 제품 범위가 화면의 몇 배까지면 쓰는지. 배경 제거가 거품 · 물방울까지 제품으로 잡아 범위가 크게 재진다.
# 실측(2026-11-05): 제품 한 병이 거품 배경과 함께 1.58로 재진 사진은 깔끔했고, 두 병이 2.02인 사진은 병이 잘렸다
KEEP = 1.6
DEPTH_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
_depth = None


def depth_session():
    global _depth
    if _depth is None:
        cache = os.path.join(os.path.expanduser("~"), ".cache", "mcb-depth")
        os.makedirs(cache, exist_ok=True)
        path = os.path.join(cache, "depth-anything-v2-small.onnx")
        if not os.path.exists(path):
            tmp = path + ".part"
            urllib.request.urlretrieve(DEPTH_URL, tmp)
            os.replace(tmp, path)
        _depth = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    return _depth


def depth_map(im):
    """0~1, 클수록 가깝다. 실패하면 None."""
    try:
        s = depth_session()
        x = np.asarray(im.resize((518, 518), Image.BICUBIC)).astype("float32") / 255.0
        x = (x - np.array([0.485, 0.456, 0.406], "float32")) / np.array([0.229, 0.224, 0.225], "float32")
        x = x.transpose(2, 0, 1)[None]
        d = s.run(None, {s.get_inputs()[0].name: x})[0].squeeze()
        d = (d - d.min()) / (d.max() - d.min() + 1e-6)
        return cv2.resize(d, im.size, interpolation=cv2.INTER_LINEAR)
    except Exception as e:
        print(f"깊이 실패: {e}", file=sys.stderr)
        return None


def inpaint(rgb, alpha):
    """전경 뒤 빈자리를 채운다. 큰 사진은 줄여서 채운 뒤 키운다."""
    mask = cv2.dilate((alpha > 0.1).astype("uint8") * 255, np.ones((31, 31), "uint8"))
    small = cv2.resize(rgb, None, fx=0.25, fy=0.25)
    m = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(small, m, 9, cv2.INPAINT_TELEA)
    big = cv2.GaussianBlur(cv2.resize(filled, (rgb.shape[1], rgb.shape[0])), (0, 0), 6)
    k = cv2.GaussianBlur(mask, (0, 0), 8)[..., None] / 255.0
    return (rgb * (1 - k) + big * k).astype("uint8")


def cover(im, fx=0.5, fy=0.5, extra=1.16):
    s = max(W / im.width, H / im.height) * extra
    out = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return out, round((W - out.width) * fx), round((H - out.height) * fy), s


def frame_on(im, box, extra):
    """제품이 가운데 오게 세로 화면을 잡는다. (가로 위치, 세로 위치, 제품이 화면 안에 들어오는지). 제품 범위를 모르면 가운데."""
    if box is None:
        return 0.5, 0.5, True
    s = max(W / im.width, H / im.height) * extra
    over_w, over_h = im.width * s - W, im.height * s - H
    fx = min(1, max(0, ((box[0] + box[2]) / 2 * s - W / 2) / over_w)) if over_w > 0 else 0.5
    fy = min(1, max(0, ((box[1] + box[3]) / 2 * s - H / 2) / over_h)) if over_h > 0 else 0.5
    # 카메라가 움직여도 제품이 잘리지 않게 여유를 둔다
    fits = (box[2] - box[0]) * s <= W * KEEP and (box[3] - box[1]) * s <= H * KEEP
    return fx, fy, fits


def clean_backdrop(rgb, alpha):
    """오린 제품 뒤에 까는 코드 배경. 사진의 배경색으로 위아래 그라데이션과 가운데 빛을 만든다. 움직임 여유만큼 크게 만든다."""
    rest = rgb[alpha <= 0.1]
    base = np.median(rest, axis=0) if len(rest) else np.array([235.0, 232.0, 226.0])
    w, h = round(W * 1.12), round(H * 1.12)
    y = np.linspace(0, 1, h)[:, None, None]
    grad = base * 1.1 * (1 - y) + base * 0.8 * y
    xx, yy = np.meshgrid(np.linspace(-1, 1, w), np.linspace(-1, 1, h))
    glow = np.exp(-(xx ** 2 / 0.5 + (yy + 0.05) ** 2 / 0.22))[..., None]
    img = grad + (255 - grad) * glow * 0.28
    # 띠가 보이지 않게 아주 약한 무늬를 얹는다. 같은 사진은 늘 같은 결과가 나오게 시드를 고정한다
    img = img + np.random.default_rng(7).normal(0, 1.2, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype("uint8"))


def with_shadow(fg, blur=26, dy=26):
    alpha = fg.getchannel("A").filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * 0.55))
    pad = 80
    c = Image.new("RGBA", (fg.width + pad * 2, fg.height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", fg.size, (0, 0, 0, 255))
    shadow.putalpha(alpha)
    c.alpha_composite(shadow, (pad, pad + dy))
    c.alpha_composite(fg, (pad, pad))
    return c


def layer(name, out_dir, im, left, top, kind):
    file = f"{name}.jpg" if im.mode == "RGB" else f"{name}.png"
    path = os.path.join(out_dir, file)
    im.save(path, **({"quality": 93} if im.mode == "RGB" else {}))
    return {"file": file, "path": path, "left": int(left), "top": int(top), "w": im.width, "h": im.height, "kind": kind}


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    im = Image.open(src).convert("RGB")
    rgb = np.array(im)
    session = new_session("isnet-general-use")
    fg = remove(im, session=session)
    alpha = np.array(fg)[:, :, 3] / 255.0
    ratio = float((alpha > 0.5).mean())
    depth = depth_map(im)

    # 전경이 실제로 앞에 있어야 분리한다. 소파만 떼어 내는 식의 오검출을 거른다
    fg_ok = 0.05 < ratio < 0.7
    if fg_ok and depth is not None:
        fg_ok = float(depth[alpha > 0.5].mean()) > float(depth[alpha <= 0.5].mean()) + 0.12

    layers = []
    mode = "push"
    soft = False
    # 작은 오검출 점은 빼고 범위를 잰다. 사진 대부분이 전경으로 잡히면 질감 · 장면 사진이라 범위를 보지 않는다
    solid = alpha > 0.5
    xs = np.where(solid.sum(axis=0) > 6)[0]
    ys = np.where(solid.sum(axis=1) > 6)[0]
    box = (int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1) if len(xs) and len(ys) and 0.02 < ratio <= 0.7 else None
    fx, fy, fits = frame_on(im, box, 1.16)
    if fg_ok:
        touches = box[0] <= 3 or box[1] <= 3 or box[2] >= im.width - 3 or box[3] >= im.height - 3
        plate = Image.fromarray(inpaint(rgb, alpha))
        if not touches and ((box[2] - box[0]) / im.width > 0.45 or not fits):
            # 제품 전체가 사진 안에 있고 넓거나 세로로 채우면 잘린다: 잘리지 않게 띄운다
            mode = "float"
            bg = clean_backdrop(rgb, alpha)
            layers.append(layer("bg", out_dir, bg, (W - bg.width) / 2, (H - bg.height) / 2, "bg"))
            cut = fg.crop(box)
            # 희미하게 남은 배경까지 그림자가 생기면 사각형 테두리가 보인다
            cut.putalpha(cut.getchannel("A").point(lambda v: 0 if v < 48 else v))
            s = 980 / cut.width
            soft = s > 2.4
            shot = with_shadow(cut.resize((round(cut.width * s), round(cut.height * s)), Image.LANCZOS))
            layers.append(layer("fg", out_dir, shot, (W - shot.width) / 2, (H - shot.height) / 2 - 40, "fg"))
        elif fits:
            mode = "aligned"
            bg, l, t, s = cover(plate, fx=fx, fy=fy)
            soft = s > 2.8
            layers.append(layer("bg", out_dir, bg.filter(ImageFilter.GaussianBlur(4)), l, t, "bg"))
            front, _, _, _ = cover(fg, fx=fx, fy=fy)
            layers.append(layer("fg", out_dir, front, l, t, "fg"))
    elif fits and depth is not None and float(depth.std()) > 0.14:
        # 먼 쪽과 가까운 쪽이 뚜렷하면 나눈다
        soft_d = cv2.GaussianBlur(depth, (0, 0), 3)
        thr = cv2.threshold((soft_d * 255).astype("uint8"), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[0] / 255.0
        near = np.clip((soft_d - thr) / 0.05, 0, 1)
        if 0.15 < float(near.mean()) < 0.8:
            mode = "depth"
            plate = Image.fromarray(inpaint(rgb, near))
            near_im = Image.fromarray(np.dstack([rgb, (near * 255).astype("uint8")]).astype("uint8"), "RGBA")
            far, l, t, s = cover(plate, fx=fx, fy=fy if box else 0.6)
            soft = s > 2.8
            front, _, _, _ = cover(near_im, fx=fx, fy=fy if box else 0.6)
            layers.append(layer("far", out_dir, far, l, t, "far"))
            layers.append(layer("near", out_dir, front, l, t, "near"))
    if not layers and fits:
        whole, l, t, s = cover(im, fx=fx, fy=fy, extra=1.1)
        soft = s > 2.4
        layers.append(layer("whole", out_dir, whole, l, t, "whole"))
    if not layers:
        mode = "unfit"
    # fit: 세로로 채웠을 때 제품이 화면보다 얼마나 큰지(1보다 크면 잘린다). 기준을 맞출 때 본다
    over = 0.0
    if box:
        s = max(W / im.width, H / im.height) * 1.16
        over = max((box[2] - box[0]) * s / W, (box[3] - box[1]) * s / H)
    print(json.dumps({"mode": mode, "soft": soft, "ratio": round(ratio, 3), "fit": round(over, 2), "layers": layers}, ensure_ascii=False))


if __name__ == "__main__":
    main()
