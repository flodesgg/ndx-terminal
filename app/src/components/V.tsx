import type { ReactNode } from "react";
import { NA, signClass } from "@/lib/format";

/**
 * A formatted value cell. Missing values (null, undefined, "", or a formatter's `N.A.`) render
 * as a dim `N.A.` (SPEC §1.2, §4.2 `dim`), never as 0 or a dash.
 */
export function V({ children }: { children?: ReactNode }) {
  if (children === null || children === undefined || children === "" || children === NA)
    return <span className="na">{NA}</span>;
  return <>{children}</>;
}

/** Dim `N.A.` on its own. */
export function NAValue() {
  return <span className="na">{NA}</span>;
}

/**
 * A signed value in up/down colour: the colour follows the text shown, so a value that rounds to
 * zero is neither red nor green (§4.2 "never colour alone"); missing is dim `N.A.`.
 */
export function Sgn({
  v,
  children,
  as: Tag = "span",
  className,
}: {
  v: number | null | undefined;
  children: string;
  as?: "span" | "td" | "dd";
  className?: string;
}) {
  const cls = [className, signClass(v, children)].filter(Boolean).join(" ");
  return (
    <Tag className={cls || undefined}>
      <V>{children}</V>
    </Tag>
  );
}
