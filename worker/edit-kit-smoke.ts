// .env.local 로드는 다른 어떤 import보다 먼저 (dev 전용 — GitHub Actions에선 no-op).
import "./load-env";

import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditGraphic, EditPlan } from "@/lib/agents/edit-plan";
import type { ProductFacts } from "@/lib/agents/product-facts";
import { DEFAULT_LOOK } from "@/lib/shoot/video-kit/caption-style";
import { readClip, renderKitEdit } from "@/lib/shoot/video-kit/pipeline";
import { ffmpeg } from "@/lib/shoot/video-kit/tools";

// 편집 키트 점검 — 러너에서 브라우저 · HyperFrames · 믹스가 도는지와 렌더 시간을 잰다. 시험 영상으로 돌고 DB에 쓰지 않는다.
// 에이전트를 부르지 않는다. 음성은 SMOKE_VOICE=1일 때만 kit.json의 모델로 만들고, 아니면 말 길이를 어림한다.

const blank: EditGraphic = {
  type: "chip", at_word: "", at: 0, text: "", small: "", sub: "", note: "", chip: "", tone: "", side: "", number: "", unit: "", left: "", right: "", left_value: 0, right_value: 0, items: [], x: 0, y: 0, r: 0, from: "",
};

const plan: EditPlan = {
  look: { ...DEFAULT_LOOK },
  analysis: [],
  hook: { on_screen: "이 버튼\n왜 두 개?", highlight: "두 개", position: "top", spoken: "이 버튼 왜 두 개일까요?" },
  thumbnail: { title: "버튼\n왜 두 개?", highlight: "두 개", position: "top", sub: "시험 영상", clip: 1, at: 1 },
  beats: [
    { mode: "tts", tts: "이 버튼 왜 두 개일까요?", captions: [], emphasis: [], cuts: [{ clip: 1, in: 0.2, out: 2, what: "시험 1" }], graphics: [], sfx: [{ name: "whoosh", at_word: "", at: 0 }] },
    { mode: "tts", tts: "왼쪽 오른쪽 온도를 따로 맞춰요.", captions: ["왼쪽 오른쪽 온도를", "따로 맞춰요"], emphasis: ["따로"], cuts: [{ clip: 2, in: 0.5, out: 2.2, what: "시험 2" }], graphics: [{ ...blank, type: "split", at: 0.1, left: "왼쪽", right: "오른쪽", left_value: 1, right_value: 0.4 }], sfx: [{ name: "click", at_word: "", at: 0.3 }] },
    { mode: "tts", tts: "열다섯 시간 지나면 꺼져요.", captions: ["15시간 지나면 꺼져요"], emphasis: ["15시간"], cuts: [{ clip: 1, in: 2.2, out: 4, what: "시험 3" }], graphics: [{ ...blank, type: "stat", at: 0.1, number: "15", unit: "시간", text: "지나면 자동 꺼짐" }], sfx: [{ name: "tick", at_word: "", at: 0.1 }] },
    { mode: "tts", tts: "세탁망에 넣어서 울코스로요.", captions: ["세탁망에 넣어서 울코스로요"], emphasis: ["울코스"], cuts: [{ clip: 2, in: 2.4, out: 4, what: "시험 4" }], graphics: [{ ...blank, type: "steps", at: 0.05, items: ["세탁망에 넣고", "울코스로"], note: "시험 안내" }], sfx: [{ name: "pop", at_word: "", at: 0.1 }] },
    { mode: "tts", tts: "쿠마마켓에서 찾아보세요!", captions: ["쿠마마켓에서 찾아보세요!"], emphasis: ["쿠마마켓"], cuts: [{ clip: 1, in: 4.2, out: 5.8, what: "시험 5" }], graphics: [{ ...blank, type: "end_card", chip: "쿠마마켓", text: "시험 상품", sub: "싱글 · 더블", note: "사용 전 설명서를 확인하세요" }], sfx: [{ name: "ding", at_word: "", at: 0.1 }] },
  ],
  visuals: [],
  warnings: [],
};

const facts = { id: "smoke", name: "시험 상품", rawName: "시험 상품", shop: "시험", kind: "OTHER", kindLabel: "시험", price: null, stockStatus: "available", url: "", detailImages: 0, oneLine: null, usage: null, cautions: null, details: {}, claims: [], uncertainties: [], healthFunctional: false, approvedClaims: [], certifiedFunctions: [], sourceText: "" } as ProductFacts;

async function main() {
  if (process.env.SMOKE_VOICE !== "1") delete process.env.FISH_API_KEY;
  // 프레임 검수도 부르지 않는다. AI 이미지 컷을 시험할 때만 OpenAI를 쓴다
  const visual = process.env.SMOKE_VISUAL === "1";
  if (!visual) delete process.env.OPENAI_API_KEY;
  const workDir = join(tmpdir(), `edit-kit-smoke-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const started = Date.now();
  try {
    const files = [1, 2].map((no) => {
      const f = join(workDir, `in${no}.mp4`);
      ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=7`, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", f]);
      return f;
    });
    const clips = files.map((f, i) => readClip(i + 1, f, { shot: `시험 ${i + 1}` }));
    const r = await renderKitEdit({
      workDir: join(workDir, "kit"),
      service: null,
      accountName: "smoke",
      liveVoice: false,
      facts: visual ? { ...facts, kind: "COSMETIC", sourceText: "연어에서 추출한 소듐디엔에이" } : facts,
      rules: [],
      clips,
      reusePlan: visual
        ? { ...plan, visuals: [{ beat: 2, key: "smoke-sodium-dna", subject: "연어 유래 소듐디엔에이를 나타낸 투명한 이중 나선", evidence: "연어에서 추출한 소듐디엔에이", prompt: "Glassy double-helix strands suspended in translucent coral-pink liquid with tiny clear droplets.", motion: "liquid" }] }
        : plan,
    });
    console.log(`[edit-kit-smoke] 통과 — ${Math.round((Date.now() - started) / 1000)}초, 영상 ${r.seconds.toFixed(1)}초, ${(statSync(r.final).size / 1024 / 1024).toFixed(1)}MB, 표지 ${(statSync(r.cover).size / 1024).toFixed(0)}KB, ${r.loudness} LUFS, 음성 ${r.usedVoice ? "있음" : "없음"}`);
    console.log("경고:", r.warnings);
    if (visual) {
      console.log("AI 이미지:", r.visuals, "컷:", r.timeline.cuts.map((c) => `${c.clip}:${c.start}-${c.end}`).join(" "), "구간:", r.segments.map((s) => s.cut).join(","));
      mkdirSync("smoke-out", { recursive: true });
      copyFileSync(r.final, join("smoke-out", "smoke.mp4"));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[edit-kit-smoke] 실패:", err);
    process.exit(1);
  });
