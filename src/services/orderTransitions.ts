import type { OrderStatus } from "@prisma/client";

export type { OrderStatus };

/**
 * Order state machine — the single source of truth for legal status changes.
 * Kept dependency-free so it can be unit-tested without a database.
 */

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["STAFF_REVIEW", "CANCELLED"],
  // Payment must pass through AWAITING_PAYMENT — no STAFF_REVIEW/QUOTED → PAID shortcut.
  STAFF_REVIEW: ["QUOTED", "CANCELLED"],
  QUOTED: ["AWAITING_PAYMENT", "CANCELLED"],
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

/**
 * Statuses that represent an active order workflow. While an order is in one
 * of these states, the customer cannot close its ticket (it would orphan the
 * order) — the order must be cancelled or completed first.
 */
export const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "SUBMITTED",
  "STAFF_REVIEW",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAID",
  "IN_PROGRESS",
  "READY",
]);
