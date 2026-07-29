/**
 * Deployment configuration check (Step 7, Handbook §5).
 *
 * A deployed instance is only useful if its environment is complete, and the
 * worst way to discover otherwise is a customer's message failing at 2am. This
 * runs once at boot and reports everything wrong at once.
 *
 * Split into two severities, because they fail differently:
 *  - **missing**: the app cannot do its job (no database, no way to log in).
 *  - **warnings**: it will run, but degraded in a way worth saying out loud
 *    (e.g. no signature verification, no scheduler secret).
 */
import { MIN_PASSCODE_LENGTH } from "@/lib/auth/gate";

export interface EnvReport {
  missing: string[];
  warnings: string[];
}

function value(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function checkEnvironment(
  isProduction = process.env.NODE_ENV === "production",
): EnvReport {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (value("DATABASE_URL") === "") missing.push("DATABASE_URL");

  if (isProduction) {
    const passcode = value("CONSOLE_PASSCODE");
    if (passcode === "") {
      missing.push(
        "CONSOLE_PASSCODE (the console would serve case data openly)",
      );
    } else if (passcode.length < MIN_PASSCODE_LENGTH) {
      missing.push(
        `CONSOLE_PASSCODE (must be at least ${MIN_PASSCODE_LENGTH} characters)`,
      );
    }

    // WhatsApp credentials are only required once Meta is wired up (Step 8), so
    // an incomplete set is a warning: the console and simulator still work.
    const whatsapp = [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
    ].filter((name) => value(name) === "");
    if (whatsapp.length > 0 && whatsapp.length < 3) {
      warnings.push(
        `WhatsApp is partly configured; missing ${whatsapp.join(", ")}`,
      );
    }

    if (
      value("WHATSAPP_ACCESS_TOKEN") !== "" &&
      value("WHATSAPP_APP_SECRET") === ""
    ) {
      warnings.push(
        "WHATSAPP_APP_SECRET is not set, so inbound webhooks will be rejected " +
          "in production (signature verification is mandatory, SPEC §10)",
      );
    }

    if (value("MAINTENANCE_SECRET") === "" && value("CRON_SECRET") === "") {
      warnings.push(
        "Neither MAINTENANCE_SECRET nor CRON_SECRET is set, so the inactivity " +
          "job (SPEC §11) cannot be triggered on a schedule",
      );
    }

    if (value("SIMULATOR_ENABLED") === "true") {
      warnings.push(
        "SIMULATOR_ENABLED=true — the simulator writes real cases in this " +
          "deployment (it is behind the console passcode)",
      );
    }
  }

  return { missing, warnings };
}

export function formatEnvReport(report: EnvReport): string {
  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push(`missing required configuration: ${report.missing.join(", ")}`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
