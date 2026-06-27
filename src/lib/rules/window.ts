/**
 * Computed field `within_return_window` (SPEC.md §2): order_date +
 * merchant.return_window_days vs now. Pure; the result is fed into the rule
 * context as a field that routing rules can reference.
 */
export function isWithinReturnWindow(
  orderDate: Date | string,
  returnWindowDays: number,
  now: Date = new Date(),
): boolean {
  const start = typeof orderDate === "string" ? new Date(orderDate) : orderDate;
  if (Number.isNaN(start.getTime())) return false;

  const deadline = new Date(start);
  deadline.setDate(deadline.getDate() + returnWindowDays);
  return now.getTime() <= deadline.getTime();
}
