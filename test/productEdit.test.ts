import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ products: vi.fn(), community: vi.fn(), remove: vi.fn(), create: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/database/prisma.js", () => ({ prisma: {
  product: { findMany: mocks.products },
  $transaction: mocks.transaction,
} }));
vi.mock("../src/services/CommunityService.js", () => ({ findCommunityByName: mocks.community }));
vi.mock("../src/services/AuditService.js", () => ({ audit: vi.fn() }));
import { editProduct } from "../src/services/ProductService.js";
beforeEach(() => {
  vi.resetAllMocks(); mocks.products.mockResolvedValue([{ id: 1, name: "Pack", minQuantity: 1, maxQuantity: null }]);
  mocks.community.mockResolvedValue({ id: 2 }); mocks.update.mockResolvedValue({ name: "Pack" });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ productCommunity: { deleteMany: mocks.remove, create: mocks.create }, product: { update: mocks.update } }));
});
describe("product restriction editing", () => {
  it("validates all replacement communities before removing any existing restriction", async () => {
    mocks.community.mockResolvedValueOnce({ id: 2 }).mockRejectedValueOnce(new Error("missing community"));
    await expect(editProduct("g1", "admin", "Pack", { communityNames: ["valid", "missing"] })).rejects.toThrow("missing community");
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("replaces restrictions and product fields in one transaction, deduplicating communities", async () => {
    await editProduct("g1", "admin", "Pack", { price: 2, communityNames: ["group", "group"] });
    expect(mocks.transaction).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { price: 2 } });
  });
  it("supports explicitly clearing restrictions without deleting the product", async () => {
    await editProduct("g1", "admin", "Pack", { communityNames: [] });
    expect(mocks.remove).toHaveBeenCalledTimes(1); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).toHaveBeenCalled();
  });
});
