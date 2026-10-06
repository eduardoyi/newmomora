/** "$74.70" from cents + a currency code (the one money format of the checkout and order-status screens). */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}
