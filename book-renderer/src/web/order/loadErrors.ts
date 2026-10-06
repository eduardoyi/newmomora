/**
 * Buyer-facing copy for a failed READ on the order screens (the orders list and
 * the status pages). A raw Supabase / server message ("JWT expired", "Failed to
 * fetch", a Postgres error) is never shown: the screens show these and log the
 * raw error to the console for us.
 */

export const ORDERS_LOAD_ERROR = "We couldn't load your orders. Check your connection and try again.";
export const ORDER_LOAD_ERROR = "We couldn't load this order. Check your connection and try again.";
export const ORDER_NOT_FOUND_ERROR = "We couldn't find this order, or you don't have access to it.";

/** Logs the raw error (for us) and returns the friendly copy (for the buyer). */
export function friendlyLoadError(raw: unknown, friendly: string, where: string): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'object' && raw !== null && 'message' in raw ? String((raw as { message: unknown }).message) : String(raw);
  console.error(`${where} failed:`, text);
  return friendly;
}
