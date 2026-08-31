import { CUSTOM_ID_PREFIX } from "../config/constants.js";
import { registerInteraction } from "../handlers/interactionHandler.js";
import { pageEligibility, refreshEligibility, showEligibility } from "../services/EligibilityService.js";

export function registerEligibleInteractions(): void {
  registerInteraction(CUSTOM_ID_PREFIX.eligible, "show", ["button"], showEligibility);
  registerInteraction(CUSTOM_ID_PREFIX.eligible, "refresh", ["button"], refreshEligibility);
  registerInteraction(CUSTOM_ID_PREFIX.eligible, "page", ["button"], pageEligibility);
}
