import { describe, expect, it } from "vitest";
import {
  countdown,
  filterVenues,
  fmtDst,
  fmtHours,
  fmtOffset,
  nextSpecial,
  stateClass,
  type Venue,
} from "./venues";

const tokyo = {
  code: "JT",
  name: "Tokyo Stock Exchange",
  mic: "XTKS",
  tz: "Asia/Tokyo",
  country: "JP",
  state: "BREAK",
  next_change: "2026-11-10T03:30:00Z",
  today: {
    day: "2026-11-10",
    open: "2026-11-10T00:00:00Z",
    close: "2026-11-10T06:30:00Z",
    break_start: "2026-11-10T02:30:00Z",
    break_end: "2026-11-10T03:30:00Z",
    early_close: false,
  },
  next_session: null,
  special: [{ day: "2026-11-23", kind: "holiday", name: "Labor Thanksgiving Day", close: null }],
  known_until: "2027-02-05",
  utc_offset_s: 9 * 3600,
  dst_change: null,
  dst_offset_s: null,
} as unknown as Venue;

const ny = {
  ...tokyo,
  code: "US",
  name: "NYSE / Nasdaq",
  mic: "XNYS",
  tz: "America/New_York",
  country: "US",
  state: "OPEN",
  special: [{ day: "2026-11-27", kind: "early_close", name: null, close: "2026-11-27T18:00:00Z" }],
  utc_offset_s: -5 * 3600,
  dst_change: "2027-03-14T07:00:00Z",
  dst_offset_s: -4 * 3600,
} as unknown as Venue;

describe("CDR transforms", () => {
  it("filters by code, calendar, name or country", () => {
    expect(filterVenues([tokyo, ny], [])).toHaveLength(2);
    expect(filterVenues([tokyo, ny], ["tokyo"])).toEqual([tokyo]);
    expect(filterVenues([tokyo, ny], ["XNYS"])).toEqual([ny]);
    expect(filterVenues([tokyo, ny], ["jp", "stock"])).toEqual([tokyo]);
  });

  it("hours are in the venue's own zone, with the lunch break", () => {
    expect(fmtHours(tokyo.today, tokyo.tz)).toBe("09:00–15:30 (break 11:30–12:30)");
    expect(fmtHours(null, tokyo.tz)).toBe("N.A.");
  });

  it("states, countdowns, offsets and special days", () => {
    expect(stateClass("OPEN")).toBe("up");
    expect(stateClass("BREAK")).toBe("amber");
    expect(stateClass("CLOSED")).toBe("dim");
    expect(stateClass(null)).toBe("dim");
    const now = Date.parse("2026-11-10T03:00:00Z");
    expect(countdown("2026-11-10T03:30:00Z", now)).toBe("in 30m");
    expect(countdown("2026-11-10T05:05:00Z", now)).toBe("in 2h 05m");
    expect(countdown("2026-11-13T07:00:00Z", now)).toBe("in 3d 4h");
    expect(countdown("2026-11-10T02:00:00Z", now)).toBe("now");
    expect(countdown(null, now)).toBe("N.A.");
    expect(fmtOffset(9 * 3600)).toBe("UTC+9");
    expect(fmtOffset(-5 * 3600)).toBe("UTC−5");
    expect(fmtOffset(5.5 * 3600)).toBe("UTC+5:30");
    expect(nextSpecial(tokyo)).toBe("2026-11-23 Labor Thanksgiving Day");
    expect(nextSpecial(ny)).toBe("2026-11-27 early close 13:00");
    expect(fmtDst(ny)).toBe("2027-03-14 → UTC−4");
    expect(fmtDst(tokyo)).toBe("none");
  });
});
