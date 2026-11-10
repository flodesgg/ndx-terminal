import { describe, expect, it } from "vitest";
import { filterLog, logArgs, parseLogLine } from "./logview";

const line = (level: string, msg: string, logger = "ndx.market", extra = {}) =>
  JSON.stringify({ ts: "2026-11-09T14:30:00.123+00:00", level, logger, msg, ...extra });

describe("LOG viewer (SPEC §11: structured JSON logs, viewable in LOG)", () => {
  it("parses the server's JSON lines", () => {
    expect(parseLogLine(line("WARNING", "slow provider"))).toEqual({
      ts: "2026-11-09T14:30:00.123+00:00",
      level: "WARNING",
      logger: "ndx.market",
      msg: "slow provider",
      exc: undefined,
    });
    expect(parseLogLine(line("ERROR", "boom", "ndx.x", { exc: "Traceback…" }))?.exc).toBe(
      "Traceback…",
    );
  });

  it("keeps a line that is not JSON as raw text (old text logs, partial writes)", () => {
    expect(parseLogLine("2026-11-09 plain text")).toEqual({
      ts: null,
      level: "INFO",
      logger: "",
      msg: "2026-11-09 plain text",
      exc: undefined,
    });
    expect(parseLogLine("")).toBeNull();
  });

  it("filters by minimum level and by text (logger, message), newest last", () => {
    const entries = [
      line("DEBUG", "a"),
      line("INFO", "quote AAPL"),
      line("WARNING", "rate limited", "ndx.providers"),
      line("ERROR", "failed AAPL"),
      line("CRITICAL", "down"),
    ].map((l) => parseLogLine(l)!);
    expect(filterLog(entries, "WARNING", "").map((e) => e.msg)).toEqual([
      "rate limited",
      "failed AAPL",
      "down",
    ]);
    expect(filterLog(entries, "DEBUG", "aapl").map((e) => e.msg)).toEqual([
      "quote AAPL",
      "failed AAPL",
    ]);
    expect(filterLog(entries, "DEBUG", "providers").map((e) => e.msg)).toEqual(["rate limited"]);
  });

  it("LOG args: line count and minimum level in any order", () => {
    expect(logArgs([])).toEqual({ lines: 400, level: "DEBUG" });
    expect(logArgs(["2000"])).toEqual({ lines: 2000, level: "DEBUG" });
    expect(logArgs(["ERROR", "100"])).toEqual({ lines: 100, level: "ERROR" });
    expect(logArgs(["WARN"])).toEqual({ lines: 400, level: "WARNING" });
    expect(logArgs(["99999"])).toEqual({ lines: 5000, level: "DEBUG" }); // the server's cap
  });
});
