import { CUSTOM_ID_PREFIX } from "../config/constants.js";
import { registerInteraction } from "../handlers/interactionHandler.js";
import { registerEligibleInteractions } from "./eligible.js";
import { showOrderHistory } from "./customer.js";
import { registerProductInteractions } from "./product.js";
import { registerVerifyInteractions } from "./buttons/verify.js";
import {
  handleBackOrder,
  handleCancelForm,
  handleClaim,
  handleConfirmComplete,
  handleContinue,
  handleNoop,
  handleOrderModal,
  handleSelectCommunity,
  handleSelectProduct,
  handleStatus,
  handleSubmitOrder,
  openCancelOrderModal,
  openSetPriceModal,
  submitCancelOrderModal,
  submitSetPriceModal,
} from "./orders.js";
import {
  cancelClose,
  confirmClose,
  createTicketFromPanel,
  openCloseReasonModal,
  performClose,
  submitCloseReason,
} from "./ticket.js";

/** Side-effect registration of every persistent button/select/modal handler. */
export function registerAllInteractions(): void {
  registerVerifyInteractions();
  registerEligibleInteractions();
  registerInteraction(CUSTOM_ID_PREFIX.customer, "history", ["button"], showOrderHistory);

  // --- Products --------------------------------------------------------------
  registerProductInteractions();

  // --- Tickets -------------------------------------------------------------
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "create", ["button"], createTicketFromPanel);
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "close", ["button"], confirmClose);
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "close-confirm", ["button"], performClose);
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "cancel-close", ["button"], cancelClose);
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "close-reason", ["button"], openCloseReasonModal);
  registerInteraction(CUSTOM_ID_PREFIX.ticket, "close-reason", ["modal"], submitCloseReason);

  // --- Order form ----------------------------------------------------------
  registerInteraction(CUSTOM_ID_PREFIX.order, "select-product", ["select"], handleSelectProduct);
  registerInteraction(CUSTOM_ID_PREFIX.order, "select-community", ["select"], handleSelectCommunity);
  registerInteraction(CUSTOM_ID_PREFIX.order, "continue", ["button"], handleContinue);
  registerInteraction(CUSTOM_ID_PREFIX.order, "modal", ["modal"], handleOrderModal);
  registerInteraction(CUSTOM_ID_PREFIX.order, "back", ["button"], handleBackOrder);
  registerInteraction(CUSTOM_ID_PREFIX.order, "submit", ["button"], handleSubmitOrder);
  registerInteraction(CUSTOM_ID_PREFIX.order, "cancel", ["button"], handleCancelForm);

  // --- Staff order controls ------------------------------------------------
  registerInteraction(CUSTOM_ID_PREFIX.order, "claim", ["button"], handleClaim);
  registerInteraction(CUSTOM_ID_PREFIX.order, "set-price", ["button"], openSetPriceModal);
  registerInteraction(CUSTOM_ID_PREFIX.order, "set-price", ["modal"], submitSetPriceModal);
  registerInteraction(CUSTOM_ID_PREFIX.order, "status", ["button"], handleStatus);
  registerInteraction(CUSTOM_ID_PREFIX.order, "confirm-complete", ["button"], handleConfirmComplete);
  registerInteraction(CUSTOM_ID_PREFIX.order, "cancel-order", ["button"], openCancelOrderModal);
  registerInteraction(CUSTOM_ID_PREFIX.order, "cancel-reason", ["modal"], submitCancelOrderModal);
  registerInteraction(CUSTOM_ID_PREFIX.order, "noop", ["button"], handleNoop);
}
