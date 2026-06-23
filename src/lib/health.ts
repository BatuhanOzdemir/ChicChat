/**
 * Trivial liveness helper used by the Step 0 smoke test to prove the unit-test
 * toolchain runs. Real engine modules (normalization, rules, intake) land in
 * later steps under this same `src/lib` tree.
 */
export function ping(): "pong" {
  return "pong";
}
