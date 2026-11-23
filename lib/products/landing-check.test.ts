import assert from "node:assert/strict";
import test from "node:test";
import { parseProductUrl } from "./landing-check";
import { landingStatusOf } from "./shop-api";

// 광고 랜딩 상품 점검 — 주소 판별 · 판매 상태 판정 (2026-11-23)

test("몰 상품 주소에서 몰 · 상품번호를 읽고 utm · 해시 · 끝 슬래시는 무시한다", () => {
  assert.deepEqual(
    parseProductUrl("https://www.cuma.co.kr/product/34858?utm_source=tiktok&utm_id=__CAMPAIGN_ID__"),
    { shop: "cuma", productId: 34858 },
  );
  assert.deepEqual(parseProductUrl("https://cuma.co.kr/product/1/#x"), { shop: "cuma", productId: 1 });
  assert.deepEqual(parseProductUrl("https://m.cumamarket.co.kr/product/77"), { shop: "cm", productId: 77 });
  assert.deepEqual(parseProductUrl(" https://www.reucosmetic.com/product/5 "), { shop: "ru", productId: 5 });
});

test("몰 상품 주소가 아니면 null", () => {
  assert.equal(parseProductUrl("https://www.cuma.co.kr/event/12"), null);
  assert.equal(parseProductUrl("https://www.cuma.co.kr/product/abc"), null);
  assert.equal(parseProductUrl("https://evil.example/product/1"), null);
  assert.equal(parseProductUrl("https://cuma.co.kr.evil.example/product/1"), null);
  assert.equal(parseProductUrl("javascript:alert(1)"), null);
  assert.equal(parseProductUrl("not a url"), null);
  assert.equal(parseProductUrl("https://www.cuma.co.kr/product/0"), null);
});

const NOW = Date.parse("2026-11-23T00:00:00Z");

test("목록에 안 보이는 광고 전용 상품도 재고가 있으면 판매 중", () => {
  assert.equal(
    landingStatusOf(
      {
        productStatus: "stock_in",
        minAppUserGrade: 0,
        productSaleType: { saleType: "LIMITED_QUANTITY_SALE", limitedPeriodSaleEndDate: "2023-11-29T15:41:00.000Z" },
      },
      NOW,
    ),
    "on_sale",
  );
});

test("품절 · 판매 중지 · 삭제 · 판매 전 · 기간 끝 · 구매 제한", () => {
  assert.equal(landingStatusOf({ productStatus: "temp_stock_out" }, NOW), "sold_out");
  assert.equal(landingStatusOf({ productStatus: "stock_out" }, NOW), "sold_out");
  assert.equal(landingStatusOf({ productStatus: "suspended" }, NOW), "suspended");
  assert.equal(landingStatusOf({ productStatus: "stock_in", deletedAt: "2026-11-01" }, NOW), "deleted");
  assert.equal(landingStatusOf({ productStatus: "stock_in", productSaleType: { isCommingSoon: true } }, NOW), "not_open");
  assert.equal(
    landingStatusOf(
      { productStatus: "stock_in", productSaleType: { saleType: "LIMITED_PERIOD_SALE", limitedPeriodSaleEndDate: "2026-11-01T00:00:00Z" } },
      NOW,
    ),
    "sale_ended",
  );
  assert.equal(landingStatusOf({ productStatus: "stock_in", isGiftOnly: true }, NOW), "restricted");
  assert.equal(landingStatusOf({ productStatus: "stock_in", minAppUserGrade: 2 }, NOW), "restricted");
  assert.equal(landingStatusOf({ productStatus: "weird" }, NOW), "unknown");
});
