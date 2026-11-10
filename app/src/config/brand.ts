import brand from "@brand";

/** Single source of truth for the product name: /brand.json at the repo root. */
export const BRAND: { name: string; shortName: string; identifier: string; version: string } =
  brand;
