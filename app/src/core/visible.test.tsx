import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisibleKeys } from "./visible";

type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;
let observed: Element[] = [];
let callback: Cb = () => undefined;

class FakeIO {
  constructor(cb: Cb) {
    callback = cb;
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {
    observed = [];
  }
}

function List({ keys, out }: { keys: string[]; out: (v: string[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  out(useVisibleKeys(ref, keys));
  return (
    <div ref={ref}>
      {keys.map((k) => (
        <div key={k} data-row-key={k} />
      ))}
    </div>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("useVisibleKeys", () => {
  it("is every key without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    let got: string[] = [];
    render(<List keys={["A", "B"]} out={(v) => (got = v)} />);
    expect(got).toEqual(["A", "B"]);
  });

  it("follows what the observer reports on screen", () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    let got: string[] = [];
    render(<List keys={["A", "B", "C"]} out={(v) => (got = v)} />);
    expect(observed).toHaveLength(3);
    act(() =>
      callback([
        { target: observed[0]!, isIntersecting: true },
        { target: observed[1]!, isIntersecting: true },
        { target: observed[2]!, isIntersecting: false },
      ]),
    );
    expect(got).toEqual(["A", "B"]);
    act(() =>
      callback([
        { target: observed[0]!, isIntersecting: false },
        { target: observed[2]!, isIntersecting: true },
      ]),
    );
    expect(got).toEqual(["B", "C"]);
  });
});
