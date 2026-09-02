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
  // Secondary method: profile-description code challenge (OAuth is primary).
  registerInteraction(CUSTOM_ID_PREFIX.verify, "code", ["button"], (ctx) =>
    VerificationService.openCodeModal(ctx),
  );
  registerInteraction(CUSTOM_ID_PREFIX.verify, "start", ["modal"], (ctx) =>
    VerificationService.submitStartModal(ctx),
  );
}
