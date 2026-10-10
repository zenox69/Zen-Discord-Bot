import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionContext } from "../src/handlers/interactionHandler.js";
const mocks = vi.hoisted(() => ({ product: vi.fn(), back: vi.fn(), cancel: vi.fn() }));
vi.mock("../src/database/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: vi.fn(async () => ({ enabled: true })) }));
vi.mock("../src/services/OrderService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/OrderService.js")>(),
  handleProductSelect: mocks.product, handleBack: mocks.back, cancelOrder: mocks.cancel,
}));
import { handleSelectProduct, handleBackOrder, handleCancelForm } from "../src/interactions/orders.js";
beforeEach(() => { vi.clearAllMocks(); });
describe("order form acknowledgements", () => {
  it.each([
    ["product", handleSelectProduct, mocks.product],
    ["back", handleBackOrder, mocks.back],
    ["cancel", handleCancelForm, mocks.cancel],
  ] as const)("acknowledges %s before member lookup and clears the placeholder", async (_name, handler, action) => {
    const interaction = {
      guildId: "g1", user: { id: "u1" }, channel: { id: "c1", partial: false },
      message: { edit: vi.fn() }, values: ["10"],
      deferred: false, replied: false,
      isButton: () => true, isStringSelectMenu: () => true,
      deferReply: vi.fn(async () => { interaction.deferred = true; }),
      deleteReply: vi.fn(async () => undefined),
      guild: { id: "g1", members: { fetch: vi.fn(async () => {
        expect(interaction.deferred).toBe(true);
        return { id: "u1", guild: { id: "g1" } };
      }) } },
    };
    await handler({ interaction, parts: ["1"] } as unknown as InteractionContext);
    expect(action).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });
});
