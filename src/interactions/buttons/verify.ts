import { CUSTOM_ID_PREFIX } from "../../config/constants.js";
import { registerInteraction } from "../../handlers/interactionHandler.js";
import { VerificationService } from "../../services/VerificationService.js";

export function registerVerifyInteractions(): void {
  registerInteraction(CUSTOM_ID_PREFIX.verify, "check", ["button"], (ctx) =>
    VerificationService.check(ctx),
  );
  registerInteraction(CUSTOM_ID_PREFIX.verify, "start", ["button"], (ctx) =>
    VerificationService.openStartModal(ctx),
  );
  registerInteraction(CUSTOM_ID_PREFIX.verify, "start", ["modal"], (ctx) =>
    VerificationService.submitStartModal(ctx),
  );
}
