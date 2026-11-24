import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mercariSalesCandidate, readCsv } from "@/lib/commerce/imports/mercari-sales";
import { saleRecordId } from "@/lib/commerce/sale-ids";
import { readSalesHistory, salesHistoryDate } from "@/lib/commerce/imports/sales-history";
import { z } from "zod";

describe("販売CSV候補", () => {
  it("BOM・引用符・改行を読み取り、更新日を初期表示し金額を保持する", () => {
    const csv =
      '\uFEFF商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時,販売利益\r\nm1,"30枚,セット\n""特価""",999999999999999,0,215,2026-11-01 10:00:00,2026-11-10 12:00:00,999999999999784\r\n';
    const [row] = mercariSalesCandidate(csv, "sales.csv", randomUUID);
    expect(row).toMatchObject({
      sourceName: '30枚,セット\n"特価"',
      price: "999999999999999",
      priceBasis: "TOTAL",
      quantity: 1,
      fee: "0",
      shipping: "215",
      date: "2026-11-10",
      skuId: "",
      completed: false,
      selected: false,
    });
    expect(row!.source?.updatedAt).toBe("2026-11-10 12:00:00");
  });
  it("日本時間の日付を使い、不正日付を補正せず空欄にする", () => {
    expect(salesHistoryDate("2026-11-10 00:01:00")).toBe("2026-11-10");
    expect(salesHistoryDate("2026-11-09T15:01:00Z")).toBe("2026-11-10");
    expect(salesHistoryDate("2026-11-10T23:30:00-08:00")).toBe("2026-11-11");
    for (const value of [
      "",
      "不明",
      "2026-02-30",
      "2026-13-01",
      "2026-11-10 24:00:00",
      "2026-11-10 12:70:00",
    ])
      expect(salesHistoryDate(value)).toBe("");
    expect(() => readSalesHistory("商品名,価格\n商品,100", "other.csv", randomUUID)).toThrow(
      "現在はメルカリ",
    );
  });
  it("見出し不足・列数不一致・不正な引用符を拒否する", () => {
    expect(readCsv('商品名,金額\nArtistBox"shine",100')).toEqual([
      ["商品名", "金額"],
      ['ArtistBox"shine"', "100"],
    ]);
    expect(() => mercariSalesCandidate("商品ID,商品名\nx,y", "x.csv", randomUUID)).toThrow(
      "見出し",
    );
    expect(() => readCsv('x,"a')).toThrow("閉じられて");
    expect(() => readCsv('"a"b,c')).toThrow("引用符");
    const header = "商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時";
    expect(() => mercariSalesCandidate(`${header}\nx,y`, "x.csv", randomUUID)).toThrow("列数");
    expect(() =>
      mercariSalesCandidate(`${header},商品ID\nx,y,1,0,0,a,b,x`, "x.csv", randomUUID),
    ).toThrow("見出し");
  });
  it("758件を切り捨てずに保持し、元IDの重複も修正候補として残す", () => {
    const csv =
      "商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時\n" +
      Array.from({ length: 758 }, () => "same,商品,100,10,0,2026-01-01,2026-02-01").join("\n");
    const rows = mercariSalesCandidate(csv, "x.csv", randomUUID);
    expect(rows).toHaveLength(758);
    expect(new Set(rows.map((r) => r.id)).size).toBe(758);
  });
  it("仮反映と実保存が同じUUIDを使用し、要求・記録種別を分離する", () => {
    const key = randomUUID();
    expect(z.uuid().parse(saleRecordId(key, "order"))).toBe(saleRecordId(key, "order"));
    expect(saleRecordId(key, "order")).not.toBe(saleRecordId(key, "line"));
    expect(saleRecordId(key, "order")).not.toBe(saleRecordId(randomUUID(), "order"));
  });
});
