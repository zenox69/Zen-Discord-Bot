import type { MarketplaceCommand } from "../handlers/commandHandler.js";
import { communityCommand } from "./community/community.js";
import { customerCommand } from "./customer/customer.js";
import { eligibleCommand } from "./eligible/eligible.js";
import { eligibilityCommand } from "./eligibility/eligibility.js";
import { productCommand } from "./product/product.js";
import { robloxCommand } from "./roblox/roblox.js";
import { setupCommand } from "./setup/setup.js";
import { ticketCommand } from "./ticket/ticket.js";
import { verifyCommand } from "./verify/verify.js";

/**
 * Central command registry — the single source of truth shared by the bot
 * runtime and scripts/deployCommands.ts.
 */
export const allCommands: MarketplaceCommand[] = [
  setupCommand,
  verifyCommand,
  robloxCommand,
  eligibleCommand,
  eligibilityCommand,
  communityCommand,
  customerCommand,
  productCommand,
  ticketCommand,
];
