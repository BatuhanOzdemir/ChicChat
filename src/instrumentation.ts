/**
 * Boot hook (Step 7): check the deployment's configuration once, loudly.
 *
 * Warnings are logged and the app starts. Missing *required* configuration
 * throws, because a deployment without a database or without a console passcode
 * should fail its own health check rather than serve a broken or open console.
 */
import { checkEnvironment, formatEnvReport } from "@/server/env";
import { logger } from "@/server/logging/logger";

export function register(): void {
  const report = checkEnvironment();
  const summary = formatEnvReport(report);

  if (report.missing.length > 0) {
    logger.error("validation_failed", new Error(summary), {
      during: "startup",
    });
    throw new Error(`ChicChat cannot start — ${summary}`);
  }

  if (report.warnings.length > 0) {
    logger.warn("validation_failed", { during: "startup", detail: summary });
  }
}
