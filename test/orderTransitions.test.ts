import { describe, expect, it } from "vitest";
import { canTransition, type OrderStatus } from "../src/services/orderTransitions.js";

describe("order state machine", () => {
  it("follows the happy path", () => {
    const path: OrderStatus[] = [
      "DRAFT",
      "SUBMITTED",
      "STAFF_REVIEW",
      "QUOTED",
      "AWAITING_PAYMENT",
      "PAID",
      "IN_PROGRESS",
      "READY",
      "COMPLETED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `expected ${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const from of [
      "DRAFT",
      "SUBMITTED",
      "STAFF_REVIEW",
      "QUOTED",
      "AWAITING_PAYMENT",
      "PAID",
      "IN_PROGRESS",
      "READY",
    ] as OrderStatus[]) {
      expect(canTransition(from, "CANCELLED"), `expected ${from} -> CANCELLED`).toBe(true);
    }
  });

  it("allows refunds from PAID, IN_PROGRESS, READY, and COMPLETED", () => {
    for (const from of ["PAID", "IN_PROGRESS", "READY", "COMPLETED"] as OrderStatus[]) {
      expect(canTransition(from, "REFUNDED"), `expected ${from} -> REFUNDED`).toBe(true);
    }
  });

  it("rejects skipped stages", () => {
    expect(canTransition("DRAFT", "PAID")).toBe(false);
    expect(canTransition("SUBMITTED", "COMPLETED")).toBe(false);
    expect(canTransition("QUOTED", "IN_PROGRESS")).toBe(false);
    expect(canTransition("READY", "SUBMITTED")).toBe(false);
  });

  it("requires payment to pass through AWAITING_PAYMENT", () => {
    expect(canTransition("STAFF_REVIEW", "PAID")).toBe(false);
    expect(canTransition("QUOTED", "PAID")).toBe(false);
    expect(canTransition("QUOTED", "AWAITING_PAYMENT")).toBe(true);
    expect(canTransition("AWAITING_PAYMENT", "PAID")).toBe(true);
  });

  it("locks terminal states", () => {
    expect(canTransition("CANCELLED", "DRAFT")).toBe(false);
    expect(canTransition("REFUNDED", "COMPLETED")).toBe(false);
    expect(canTransition("COMPLETED", "COMPLETED")).toBe(false);
  });
});
