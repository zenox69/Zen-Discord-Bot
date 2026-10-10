import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { InteractionContext } from "../src/handlers/interactionHandler.js";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), account: vi.fn(), addBulk: vi.fn(), fetchMember: vi.fn() }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.settings }));
vi.mock("../src/database/prisma.js", () => ({ prisma: { robloxAccount: { findUnique: mocks.account } } }));
vi.mock("../src/services/ProductService.js", () => ({ addProductsBulk: mocks.addBulk, parseBulkLines: () => ({ entries: [{ name: "Pack", price: 1 }], failures: [] }) }));
vi.mock("../src/services/AuditService.js", () => ({ audit: vi.fn() }));
vi.mock("../src/utils/errorBoundary.js", () => ({ handleFatal: (fn: () => Promise<void>) => fn() }));
import { openBulkModal, submitBulkModal } from "../src/interactions/product.js";
import { pageEligibility, refreshEligibility, showEligibility } from "../src/services/EligibilityService.js";
import { registerInteraction, routeInteraction } from "../src/handlers/interactionHandler.js";

function member(roleIds: string[] = []) {
  return { id: "u1", guild: { id: "g1", ownerId: "owner" }, roles: { cache: roleIds.map((id) => ({ id })) }, permissions: { has: () => false } };
}
function interaction() {
  return { guildId: "g1", guild: { id: "g1", ownerId: "owner", members: { fetch: mocks.fetchMember } }, member: { roles: ["stale-admin"] }, user: { id: "u1" }, isButton: () => true, isModalSubmit: () => true, showModal: vi.fn(), reply: vi.fn(), fields: { getTextInputValue: () => "Pack: 1" } };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.settings.mockResolvedValue({ enabled: true, staffRoleId: "staff", adminRoleId: "admin" });
  mocks.fetchMember.mockResolvedValue(member()); mocks.account.mockResolvedValue({ discordUserId: "123456789012345678", robloxUserId: "202" });
});

describe("eligibility component permissions", () => {
  it.each([showEligibility, refreshEligibility, pageEligibility])("rejects another user's view with a raw non-staff member", async (handler) => {
    const ctx = { interaction: interaction(), parts: ["123456789012345678", "1"] } as unknown as InteractionContext;
    await expect(handler(ctx)).rejects.toMatchObject({ code: "NOT_STAFF" });
    expect(mocks.fetchMember).toHaveBeenCalledWith({ user: "u1", force: true });
  });
  it("fails closed when settings disappeared after the message was posted", async () => {
    mocks.settings.mockResolvedValue(null);
    await expect(showEligibility({ interaction: interaction(), parts: ["123456789012345678"] } as unknown as InteractionContext)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("bulk modal authorization", () => {
  async function form() {
    const opening = interaction();
    await openBulkModal(opening as unknown as ChatInputCommandInteraction, { category: null, requiresEligibility: null, communityNames: [] });
    const modal = opening.showModal.mock.calls[0]![0] as { toJSON: () => { custom_id: string } };
    return modal.toJSON().custom_id.split(":")[2]!;
  }
  it("rechecks admin permission after the role was removed", async () => {
    const token = await form();
    await expect(submitBulkModal({ interaction: interaction(), parts: [token] } as unknown as InteractionContext)).rejects.toMatchObject({ code: "NOT_ADMIN" });
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });
  it("binds modal state to its opening user and guild", async () => {
    const token = await form(); mocks.fetchMember.mockResolvedValue(member(["admin"]));
    for (const extra of [{ user: { id: "other" } }, { guildId: "other" }]) {
      await expect(submitBulkModal({ interaction: { ...interaction(), ...extra }, parts: [token] } as unknown as InteractionContext)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    }
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });
  it("only adds products once on repeated modal submissions", async () => {
    const token = await form(); mocks.fetchMember.mockResolvedValue(member(["admin"])); mocks.addBulk.mockResolvedValue({ added: [{ name: "Pack", price: 1 }], failed: [] });
    await submitBulkModal({ interaction: interaction(), parts: [token] } as unknown as InteractionContext);
    await submitBulkModal({ interaction: interaction(), parts: [token] } as unknown as InteractionContext);
    expect(mocks.addBulk).toHaveBeenCalledTimes(1);
  });
});

describe("component marketplace gate", () => {
  it("blocks stale buttons and modals when the server is disabled", async () => {
    const run = vi.fn(); registerInteraction("security-test", "gate", ["button"], run);
    mocks.settings.mockResolvedValue({ enabled: false });
    await expect(routeInteraction({ ...interaction(), customId: "security-test:gate" } as unknown as InteractionContext["interaction"])).rejects.toMatchObject({ code: "MARKETPLACE_DISABLED" });
    expect(run).not.toHaveBeenCalled();
  });
});
