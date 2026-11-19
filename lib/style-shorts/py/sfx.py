"""스타일 쇼츠 효과음 만들기 — earshot 소리 묶음에서 id로 한 개씩 만든다(모델 · 네트워크 없음).

쓰는 법: python sfx.py <요청 JSON 파일>
요청: [{"id": "swish/soft", "out": "/tmp/s0.wav", "seed": 3}, ...]
표준 출력: JSON 배열 [{"out", "ok", "peak_s", "onset_s", "dur_s", "lufs_m_max", "error"}]
"""
import json
import sys


def main():
    from earshot import api

    jobs = json.load(open(sys.argv[1], encoding="utf-8"))
    results = []
    for j in jobs:
        try:
            r = api.sfx_render(j["id"], j["out"], seed=j.get("seed"), peak_db=-1.0)
            m = r["meta"]
            results.append({
                "out": j["out"],
                "ok": True,
                "peak_s": m.get("peak_s"),
                "onset_s": m.get("onset_s"),
                "dur_s": m.get("dur_s"),
                "lufs_m_max": m.get("lufs_m_max"),
                "error": None,
            })
        except Exception as err:  # 한 소리가 실패해도 나머지는 만든다
            results.append({"out": j["out"], "ok": False, "error": f"{type(err).__name__}: {err}"[:200]})
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:
        print(f"sfx.py: {type(err).__name__}: {err}"[:300], file=sys.stderr)
        sys.exit(1)
