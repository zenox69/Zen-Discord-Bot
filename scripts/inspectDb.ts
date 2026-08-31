import { prisma } from "../src/database/prisma.js";

async function main(): Promise<void> {
  const [settings, communities, products, accounts, pending, tickets, orders] = await Promise.all([
    prisma.guildSettings.findMany(),
    prisma.robloxCommunity.findMany(),
    prisma.product.findMany(),
    prisma.robloxAccount.findMany(),
    prisma.robloxVerification.count(),
    prisma.ticket.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  console.log("--- GUILD SETTINGS ---");
  for (const s of settings) {
    console.log(
      `${s.guildId}: name="${s.marketplaceName}" staff=${s.staffRoleId ?? "-"} admin=${s.adminRoleId ?? "-"}` +
        ` ticketCat=${s.ticketCategoryId ?? "-"} panel=${s.orderPanelChannelId ?? "-"}` +
        ` enabled=${s.enabled} currency=${s.currencySymbol}`,
    );
  }
  console.log("--- COMMUNITIES ---");
  console.log(communities.map((c) => `${c.name} (group ${c.robloxGroupId}, ${c.requiredDays}d, ${c.leavePolicy}, ${c.enabled ? "on" : "off"})`).join("\n") || "(none)");
  console.log("--- PRODUCTS ---");
  console.log(products.map((p) => `${p.name} - ${p.price} ${p.currency} (${p.enabled ? "on" : "off"}, eligibility: ${p.requiresEligibility})`).join("\n") || "(none)");
  console.log("--- VERIFIED ACCOUNTS ---");
  console.log(accounts.map((a) => `${a.robloxUsername} (id ${a.robloxUserId}) linked ${a.verifiedAt.toISOString()}`).join("\n") || "(none)");
  console.log(`--- PENDING VERIFICATIONS: ${pending} ---`);
  console.log("--- TICKETS (latest 5) ---");
  console.log(tickets.map((t) => `#${t.number} ${t.type} ${t.status} ${t.channelName}`).join("\n") || "(none)");
  console.log("--- ORDERS (latest 5) ---");
  console.log(orders.map((o) => `#${o.number} ${o.status} (product ${o.productId})`).join("\n") || "(none)");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
