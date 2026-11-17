import { parseUsdc } from './adapter.mjs';

// Invert the provider's net estimate in integer micro-USDC. Verify the final
// quote even at fee-tier boundaries, where the local slope can change.
export async function exactQuote(invoice, estimate) {
  const target = BigInt(parseUsdc(invoice.amount));
  let gross = target;
  const seen = new Set();
  for (let i = 0; i < 8 && !seen.has(gross); i++) {
    seen.add(gross);
    const quote = await estimate(gross.toString());
    if (invoice.amountBasis !== 'net') return quote;
    const net = BigInt(parseUsdc(quote.net));
    if (net === target) return quote;
    const shortfall = target - net;
    const adjustment = i === 0 ? (shortfall * gross + net - 1n) / net : shortfall;
    gross += adjustment;
    if (gross < target) break;
  }
  throw Object.assign(new Error('Provider pricing could not deliver this exact amount. Review the invoice and fee tier.'), {httpStatus:422});
}
