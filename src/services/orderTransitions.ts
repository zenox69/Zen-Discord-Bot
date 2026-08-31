import type { OrderStatus } from "@prisma/client";

export type { OrderStatus };

/**
 * Order state machine — the single source of truth for legal status changes.
 * Kept dependency-free so it can be unit-tested without a database.
 */

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["STAFF_REVIEW", "CANCELLED"],
  STAFF_REVIEW: ["QUOTED", "PAID", "CANCELLED"],
  QUOTED: ["AWAITING_PAYMENT", "PAID", "CANCELLED"],
  AWAITING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["IN_PROGRESS", "REFUNDED", "CANCELLED"],
  IN_PROGRESS: ["READY", "REFUNDED", "CANCELLED"],
  READY: ["COMPLETED", "REFUNDED", "CANCELLED"],
  COMPLETED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
