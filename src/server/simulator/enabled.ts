/**
 * The simulator is a development/demo surface (SPEC §7): available outside
 * production, and in production only when explicitly enabled (so a deployed
 * instance can host the sales demo behind a flag — auth lands with deployment).
 */
export function isSimulatorEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.SIMULATOR_ENABLED === "true";
}
