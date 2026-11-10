import type { DragEvent } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, EMPTY_INDEX, setSecIndex } from "@/core/secindex";
import { TICKER_MIME, tickerDragProps } from "./dragTicker";

afterEach(() => setSecIndex(EMPTY_INDEX));

function drag(symbol: string): Record<string, string> {
  const data: Record<string, string> = {};
  const e = {
    dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: "" },
  } as unknown as DragEvent;
  tickerDragProps(symbol).onDragStart(e);
  return data;
}

describe("drag a ticker (SPEC §4.9, review 1b #22)", () => {
  it("carries the canonical ID, not the provider symbol a grid row shows (WEI: ^GSPC)", () => {
    setSecIndex(
      buildIndex({ complete: ["US"], fiat: [], items: [["SPX INDEX", "S&P 500", "^GSPC"]] }),
    );
    expect(drag("^GSPC")[TICKER_MIME]).toBe("SPX INDEX");
    expect(drag("AAPL US EQUITY")[TICKER_MIME]).toBe("AAPL US EQUITY");
    expect(drag("ZZZ.XX")[TICKER_MIME]).toBe("ZZZ.XX"); // unknown: kept as it is
  });
});
