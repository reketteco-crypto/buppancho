import { describe, expect, it } from "vitest";
import { createClientUuid } from "@/lib/client-uuid";

describe("createClientUuid", () => {
  it("randomUUIDが利用できる場合はその値を使う", () => {
    const expected = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cryptoApi = {
      randomUUID: () => expected,
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => array,
    };

    expect(createClientUuid(cryptoApi)).toBe(expected);
  });

  it("LANのHTTP接続を想定し、randomUUIDなしでもUUID v4を生成する", () => {
    const cryptoApi = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
        if (array instanceof Uint8Array) array.fill(0xaa);
        return array;
      },
    };

    expect(createClientUuid(cryptoApi)).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
  });
});
