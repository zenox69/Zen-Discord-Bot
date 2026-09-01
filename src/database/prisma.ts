import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma client for the whole process.
 * PostgreSQL is the source of truth for orders, tickets, verifications,
 * and membership state. Discord is only the interface.
 */
export const prisma = new PrismaClient({
  log: ["warn", "error"],
});
