import { describe, expect, it } from "vitest";
import { canonicalConstraintDefinition as canonical } from "../../lib/operations/constraint-definition";

describe("read-only restore constraint comparison", () => {
  it("recognizes PostgreSQL's reparsed listing CHECK without losing any condition", () => {
    const original =
      "CHECK (((workflow_version = 1) OR (((listed_quantity >= 0) AND (listed_quantity <= 1)) AND (external_listing_id IS NOT NULL) AND (components_snapshot IS NOT NULL))))";
    const restored =
      "CHECK (((workflow_version = 1) OR ((listed_quantity >= 0) AND (listed_quantity <= 1) AND (external_listing_id IS NOT NULL) AND (components_snapshot IS NOT NULL))))";
    expect(canonical(original)).toBe(canonical(restored));
  });
  it.each(["AND", "OR"])("allows associative %s grouping", (operator) => {
    expect(canonical(`CHECK ((((a = 1) ${operator} (b = 2)) ${operator} (c = 3)))`)).toBe(
      canonical(`CHECK (((a = 1) ${operator} (b = 2) ${operator} (c = 3)))`),
    );
  });
  it("preserves grouping between AND and OR", () => {
    expect(canonical("CHECK ((((a = 1) OR (b = 2)) AND (c = 3)))")).not.toBe(
      canonical("CHECK (((a = 1) OR ((b = 2) AND (c = 3))))"),
    );
  });
  it("detects a missing requirement", () => {
    expect(canonical("CHECK (((a = 1) AND (b = 2)))")).not.toBe(canonical("CHECK ((a = 1))"));
  });
  it("detects changed limits and nullability tests", () => {
    expect(canonical("CHECK (((q <= 1) AND (id IS NOT NULL)))")).not.toBe(
      canonical("CHECK (((q <= 2) AND (id IS NULL)))"),
    );
  });
  it("keeps quoted Boolean words, parentheses and doubled quotes as literal data", () => {
    expect(canonical("CHECK (((label = 'a) AND (b''s') AND (q = 1)))")).not.toBe(
      canonical("CHECK (((label = 'a) OR (b''s') AND (q = 1)))"),
    );
  });
  it("does not reinterpret BETWEEN or CASE expressions", () => {
    expect(canonical("CHECK ((v BETWEEN (1) AND (2)))")).not.toBe(
      canonical("CHECK (((v = 1) AND (v = 2)))"),
    );
    expect(canonical("CHECK ((CASE WHEN (a = 1) AND (b = 2) THEN true ELSE false END))")).not.toBe(
      canonical("CHECK (((a = 1) AND (b = 2)))"),
    );
  });
  it("preserves validation suffixes and non-CHECK definitions", () => {
    const foreignKey = "FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE RESTRICT";
    expect(canonical(foreignKey)).toBe(foreignKey);
    expect(canonical("CHECK ((q >= 0)) NOT VALID")).not.toBe(canonical("CHECK ((q >= 0))"));
  });
  it("leaves escape and dollar strings opaque", () => {
    for (const value of ["CHECK ((label = E'a\\nb'))", "CHECK ((label = $$a AND b$$))"])
      expect(canonical(value)).toBe(value);
  });
});
