import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  loadListingReturnDraftReview,
  assertListingReturnDraft,
  listingReturnDraftSnapshot,
} from "@/lib/sales/listing-return-drafts";
import {
  blankListingReturnInput,
  listingReturnDraftInputSchema,
  listingReturnSnapshotValues,
  listingReturnPlannedValues,
} from "@/lib/sales/listing-return-input";
function fixture() {
  const c = {
    workspaceId: randomUUID(),
    businessUnitId: randomUUID(),
    operatorId: randomUUID(),
    reportingEntityId: randomUUID(),
    year: 2026,
    userAccountId: randomUUID(),
  };
  const listingId = randomUUID(),
    caseId = randomUUID(),
    memberId = randomUUID(),
    reservationId = randomUUID(),
    draftId = randomUUID();
  const input = {
    ...blankListingReturnInput(listingId, caseId),
    date: "2026-10-26",
    reason: "確認",
    quantities: { [memberId + ":RESTOCK"]: "1" },
  };
  const draft = {
    id: draftId,
    workspaceId: c.workspaceId,
    businessUnitId: c.businessUnitId,
    operatorId: c.operatorId,
    year: c.year,
    kind: "LISTING_RETURN",
    revision: 1,
    archivedAt: null as Date | null,
    payload: input,
    baseSnapshot: null as unknown,
  };
  const fiscal = { status: "OPEN", updatedAt: new Date("2026-01-01Z") };
  const requests: object[] = [];
  const db = {
    listing: {
      findFirst: vi.fn().mockResolvedValue({
        revision: 1,
        status: "ACTIVE",
        returnPending: true,
        completion: null,
      }),
    },
    listingReturnCase: {
      findFirst: vi.fn().mockResolvedValue({ id: caseId, reportingEntityId: c.reportingEntityId }),
    },
    listingReturnMember: {
      findMany: vi.fn().mockResolvedValue([{ id: memberId, reservationId, quantity: 3 }]),
    },
    listingReturnHandling: { findMany: vi.fn().mockResolvedValue([]) },
    inventoryReservation: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: reservationId,
          itemVariant: {
            inventoryItem: { name: "確認用の商品" },
            costBalances: [{ carryingCostTotalJpy: 300n }],
          },
          storageLocation: { name: "主保管場所" },
          uniqueStockUnit: null,
        },
      ]),
    },
    inventoryRevision: { findUnique: vi.fn().mockResolvedValue({ revision: 2n }) },
    fiscalYearProfile: { findFirst: vi.fn().mockResolvedValue(fiscal) },
    operator: { findFirst: vi.fn().mockResolvedValue({ displayName: "入力者" }) },
    businessUnit: { findFirst: vi.fn().mockResolvedValue({ name: "部門" }) },
    reportingEntity: { findFirst: vi.fn().mockResolvedValue({ displayName: "申告主体" }) },
    workflowDraft: { findUnique: vi.fn().mockResolvedValue(draft) },
    workflowRequest: {
      findMany: vi.fn().mockResolvedValue(requests),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const tx = db as unknown as Parameters<typeof loadListingReturnDraftReview>[0];
  const start = async () => {
    const snapshot = await listingReturnDraftSnapshot(tx, c, listingId);
    draft.baseSnapshot = snapshot;
    return snapshot;
  };
  const metadata = () => ({
    listingId,
    idempotencyKey: randomUUID(),
    draftId,
    draftRevision: 1,
    draftInput: input,
    date: input.date,
    reason: input.reason,
    rows: [{ memberId, disposition: "RESTOCK", quantity: 1 }],
  });
  return {
    c,
    listingId,
    caseId,
    memberId,
    draftId,
    input,
    draft,
    fiscal,
    requests,
    db,
    tx,
    start,
    metadata,
  };
}
describe("pre-completion return draft boundaries", () => {
  it("keeps incomplete text and explicit zero distinct in resumable input", () => {
    const f = fixture(),
      blank = blankListingReturnInput(f.listingId, f.caseId);
    expect(
      listingReturnDraftInputSchema.parse({
        ...blank,
        quantities: { [f.memberId + ":RESTOCK"]: "0" },
      }).date,
    ).toBe("");
    expect(
      listingReturnDraftInputSchema.parse({
        ...blank,
        quantities: { [f.memberId + ":RESTOCK"]: "" },
      }).quantities[f.memberId + ":RESTOCK"],
    ).toBe("");
  });
  it("renders Japanese comparisons without UUIDs or raw JSON", async () => {
    const f = fixture(),
      snapshot = await f.start();
    const display = JSON.stringify([
      listingReturnSnapshotValues(snapshot),
      listingReturnPlannedValues(f.input, snapshot),
    ]);
    expect(display).toContain("確認用の商品");
    expect(display).not.toContain(f.memberId);
    expect(display).not.toContain(f.listingId);
  });
  it("accepts a current scoped draft without performing writes", async () => {
    const f = fixture();
    await f.start();
    await expect(
      assertListingReturnDraft(f.tx, f.c, f.metadata(), f.caseId),
    ).resolves.toBeUndefined();
    expect(
      (
        await loadListingReturnDraftReview(f.tx, f.c, {
          listingId: f.listingId,
          draftId: f.draftId,
        })
      ).canResolve,
    ).toBe(true);
  });
  it("rejects stale drafts and immutable-baseline changes", async () => {
    const f = fixture();
    await f.start();
    await expect(
      assertListingReturnDraft(f.tx, f.c, { ...f.metadata(), draftRevision: 0 }, f.caseId),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    f.draft.baseSnapshot = { ...(f.draft.baseSnapshot as object), reportingEntityId: randomUUID() };
    await expect(assertListingReturnDraft(f.tx, f.c, f.metadata(), f.caseId)).rejects.toMatchObject(
      { code: "OWNERSHIP_CHANGED" },
    );
  });
  it("refuses another workspace and archived input", async () => {
    const f = fixture();
    await f.start();
    await expect(
      loadListingReturnDraftReview(
        f.tx,
        { ...f.c, workspaceId: randomUUID() },
        { listingId: f.listingId, draftId: f.draftId },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    f.draft.archivedAt = new Date();
    await expect(assertListingReturnDraft(f.tx, f.c, f.metadata(), f.caseId)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });
  it("does not pass an unresolved own or foreign request", async () => {
    const f = fixture();
    await f.start();
    f.requests.push({
      id: randomUUID(),
      status: "PREPARED",
      kind: "LISTING_RETURN",
      userAccountId: f.c.userAccountId,
    });
    await expect(assertListingReturnDraft(f.tx, f.c, f.metadata(), f.caseId)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    f.requests[0] = {
      id: randomUUID(),
      status: "PREPARED",
      kind: "LISTING_RETURN",
      userAccountId: randomUUID(),
    };
    const review = await loadListingReturnDraftReview(f.tx, f.c, {
      listingId: f.listingId,
      draftId: f.draftId,
    });
    expect(review.canResolve).toBe(false);
    expect(review.activeRequest).toBeNull();
  });
  it("refuses year locks and mismatched confirmed quantities", async () => {
    const f = fixture();
    await f.start();
    await expect(
      assertListingReturnDraft(
        f.tx,
        f.c,
        {
          ...f.metadata(),
          draftInput: { ...f.input, quantities: { [f.memberId + ":RESTOCK"]: "2" } },
        },
        f.caseId,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    f.fiscal.status = "LOCKED";
    await expect(assertListingReturnDraft(f.tx, f.c, f.metadata(), f.caseId)).rejects.toMatchObject(
      { code: "YEAR_LOCKED" },
    );
  });
});
