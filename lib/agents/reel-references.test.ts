import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capReferences, referenceBlock, type ReferenceReel } from "@/lib/agents/reel-references";

const reel = (ref: string, account: string): ReferenceReel => ({ ref, account, hook: `${ref} 첫 마디`, multiple: 4, views: 1000, saved: null, shares: null, formula: null, style: null, about: "" });

describe("참고 릴스 고르기", () => {
  it("고른 릴스만 남기고 한 계정 3개까지, 번호를 다시 붙인다", () => {
    const benchmark = ["B1", "B2", "B3", "B4", "B5"].map((r) => reel(r, "a"));
    benchmark.push(reel("B6", "b"));
    const own = ["O1", "O2", "O3"].map((r) => reel(r, "우리 계정"));
    const out = capReferences({ benchmark, own, insights: ["요약"] }, new Set(["B2", "B3", "B4", "B5", "B6"]), new Set(["O3"]));
    assert.deepEqual(out.benchmark.map((r) => `${r.ref}:${r.hook}`), ["B1:B2 첫 마디", "B2:B3 첫 마디", "B3:B4 첫 마디", "B4:B6 첫 마디"]);
    assert.deepEqual(out.own.map((r) => `${r.ref}:${r.hook}`), ["O1:O3 첫 마디"]);
    assert.deepEqual(out.insights, ["요약"]);
  });

  it("우리 계정 릴스를 먼저 보여 준다", () => {
    const block = referenceBlock({ benchmark: [reel("B1", "a")], own: [reel("O1", "우리 계정")], insights: [] });
    assert.ok(block.indexOf("O1") < block.indexOf("B1"));
  });
});
