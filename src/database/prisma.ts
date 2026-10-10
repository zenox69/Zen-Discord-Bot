import { PrismaClient } from "@prisma/client";
import { log } from "../utils/logger.js";

/**
 * Single Prisma client for the whole process.
 * PostgreSQL is the source of truth for orders, tickets, verifications,
 * and membership state. Discord is only the interface.
 */
export const prisma = new PrismaClient({
  log: [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }],
});
prisma.$on("warn", (event) => log.warn("Prisma warning", event.message));
prisma.$on("error", (event) => log.error("Prisma error", event.message));
