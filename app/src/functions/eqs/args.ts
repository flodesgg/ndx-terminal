/** EQS filters <-> command args, e.g. "EQS REGION=DK SECTOR=HEALTHCARE MCAP>10B PE<25 SORT=CHG". */

export const REGIONS = [
  "us",
  "dk",
  "se",
  "no",
  "fi",
  "de",
  "gb",
  "fr",
  "nl",
  "ch",
  "it",
  "es",
  "jp",
  "hk",
  "cn",
  "kr",
  "tw",
  "au",
  "in",
  "ca",
  "br",
];
export const SECTORS = [
  "Technology",
  "Healthcare",
  "Financial Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Industrials",
  "Communication Services",
  "Energy",
  "Basic Materials",
  "Real Estate",
  "Utilities",
];
export const SORTS = ["mcap", "chg", "volume", "pe"] as const;
export type Sort = (typeof SORTS)[number];

export interface Filters {
  region: string;
  sector: string | null;
  mcapMin: number | null;
  mcapMax: number | null;
  peMax: number | null;
  chgMin: number | null;
  chgMax: number | null;
  volMin: number | null;
  sort: Sort;
  asc: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  region: "us",
  sector: null,
  mcapMin: 2e9,
  mcapMax: null,
  peMax: null,
  chgMin: null,
  chgMax: null,
  volMin: null,
  sort: "mcap",
  asc: false,
};

const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export function parseAmount(s: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)([KMBT])?$/i.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] ? SUFFIX[m[2].toUpperCase()]! : 1);
}

export function formatAmount(n: number): string {
  for (const [s, v] of [
    ["T", 1e12],
    ["B", 1e9],
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    // Compact query text echoed back into the command line (not a display value).
    const scaled = Math.round((n / v) * 1000) / 1000;
    if (Math.abs(n) >= v && Number.isInteger(scaled)) return `${scaled}${s}`;
  }
  return String(n);
}

export function parseEqsArgs(args: string[]): Filters {
  const f: Filters = { ...DEFAULT_FILTERS };
  for (const raw of args) {
    const a = raw.toUpperCase();
    let m: RegExpExecArray | null;
    if ((m = /^REGION=([A-Z]{2})$/.exec(a)) && REGIONS.includes(m[1]!.toLowerCase()))
      f.region = m[1]!.toLowerCase();
    else if ((m = /^SECTOR=(.+)$/.exec(a))) {
      const want = m[1]!.replace(/_/g, " ");
      f.sector = SECTORS.find((s) => s.toUpperCase() === want) ?? null;
    } else if ((m = /^MCAP([<>])(.+)$/.exec(a))) {
      const v = parseAmount(m[2]!);
      if (m[1] === ">") f.mcapMin = v;
      else f.mcapMax = v;
    } else if ((m = /^PE<(.+)$/.exec(a))) f.peMax = parseAmount(m[1]!);
    else if ((m = /^CHG([<>])(.+)$/.exec(a))) {
      const v = parseAmount(m[2]!);
      if (m[1] === ">") f.chgMin = v;
      else f.chgMax = v;
    } else if ((m = /^VOL>(.+)$/.exec(a))) f.volMin = parseAmount(m[1]!);
    else if (
      (m = /^SORT=(.+)$/.exec(a)) &&
      (SORTS as readonly string[]).includes(m[1]!.toLowerCase())
    ) {
      f.sort = m[1]!.toLowerCase() as Sort;
    } else if (a === "ASC") f.asc = true;
    else if (a === "ALLCAP") f.mcapMin = null;
  }
  return f;
}

export function formatEqsArgs(f: Filters): string[] {
  const out = [`REGION=${f.region.toUpperCase()}`];
  if (f.sector) out.push(`SECTOR=${f.sector.toUpperCase().replace(/ /g, "_")}`);
  if (f.mcapMin != null) out.push(`MCAP>${formatAmount(f.mcapMin)}`);
  else out.push("ALLCAP");
  if (f.mcapMax != null) out.push(`MCAP<${formatAmount(f.mcapMax)}`);
  if (f.peMax != null) out.push(`PE<${formatAmount(f.peMax)}`);
  if (f.chgMin != null) out.push(`CHG>${formatAmount(f.chgMin)}`);
  if (f.chgMax != null) out.push(`CHG<${formatAmount(f.chgMax)}`);
  if (f.volMin != null) out.push(`VOL>${formatAmount(f.volMin)}`);
  out.push(`SORT=${f.sort.toUpperCase()}`);
  if (f.asc) out.push("ASC");
  return out;
}

export function toQuery(f: Filters): Record<string, string | number | boolean | null> {
  return {
    region: f.region,
    sector: f.sector,
    mcap_min: f.mcapMin,
    mcap_max: f.mcapMax,
    pe_max: f.peMax,
    chg_min: f.chgMin,
    chg_max: f.chgMax,
    vol_min: f.volMin,
    sort: f.sort,
    desc: !f.asc,
    size: 100,
  };
}
