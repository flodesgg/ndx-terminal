/** WFX — FX monitor (SPEC §7): grouped currency pairs on the WEI board. */
import { registerFunction, type PanelProps } from "@/core/registry";
import { Board } from "@/functions/wei/WEI";
import type { WeiRow } from "@/functions/wei/rows";

const rows = (group: string, list: [string, string][]): WeiRow[] =>
  list.map(([pair, label]) => ({ symbol: `${pair} CURNCY`, label, group }));

/** The pairs as canonical IDs (SPEC §5). */
export const WFX_ROWS: readonly WeiRow[] = [
  ...rows("MAJORS", [
    ["EURUSD", "Euro / US dollar"],
    ["USDJPY", "US dollar / Yen"],
    ["GBPUSD", "Sterling / US dollar"],
    ["USDCHF", "US dollar / Swiss franc"],
    ["AUDUSD", "Australian dollar / US dollar"],
    ["USDCAD", "US dollar / Canadian dollar"],
    ["NZDUSD", "New Zealand dollar / US dollar"],
  ]),
  ...rows("EUR CROSSES", [
    ["EURGBP", "Euro / Sterling"],
    ["EURJPY", "Euro / Yen"],
    ["EURCHF", "Euro / Swiss franc"],
  ]),
  ...rows("NORDICS", [
    ["EURDKK", "Euro / Danish krone"],
    ["USDDKK", "US dollar / Danish krone"],
    ["EURSEK", "Euro / Swedish krona"],
    ["USDSEK", "US dollar / Swedish krona"],
    ["EURNOK", "Euro / Norwegian krone"],
    ["USDNOK", "US dollar / Norwegian krone"],
  ]),
  ...rows("CEE & UAH", [
    ["EURUAH", "Euro / Hryvnia"],
    ["USDUAH", "US dollar / Hryvnia"],
    ["EURPLN", "Euro / Zloty"],
    ["EURCZK", "Euro / Czech koruna"],
  ]),
];

const note = () =>
  " · without the opt-in source FX rates are official daily fixings (ECB, NBU): EOD, not live";

function WFX({ id, active }: PanelProps) {
  return <Board id={id} active={active} scope="WFX" candidates={WFX_ROWS} note={note} />;
}

export function registerWFX(): void {
  registerFunction({
    code: "WFX",
    name: "FX monitor",
    description:
      "Majors, EUR crosses, Nordic pairs, hryvnia and CEE with change, % YTD, sparkline and " +
      "source per row",
    ticker: "none",
    syntax: "WFX",
    examples: ["WFX"],
    category: "Market",
    sectors: ["CURNCY"],
    menu: ["FX"],
    args: [],
    actions: [],
    component: WFX,
  });
}
