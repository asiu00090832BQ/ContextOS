/**
 * Normalize an email sender into a bare, lowercased address: extracts the
 * address from a "Display Name <a@b.com>" header and trims/lowercases it so
 * allow-list checks are case- and format-insensitive.
 */
export function normalizeAddress(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).trim().toLowerCase();
}
