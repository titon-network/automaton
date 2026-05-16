// Shared price-string parsing for CEX adapters. Every exchange sends
// prices as decimal strings (or numbers); each adapter calls
// `parsePositivePrice(s)` and pushes the resulting Tick.
//
// Contract: returns null for malformed input AND for non-positive
// prices. Phoebe leaves are positive-by-spec (a negative price has
// no defined semantics on the wire); silently dropping the tick at
// the adapter boundary is the right defense rather than letting it
// flow downstream where the manager's confBps math assumes a sane
// half-spread.

/** Length cap to bound BigInt parsing cost (V8 BigInt parse is O(n²)
 *  in the digit count). 32 chars is far more than any real market
 *  price needs — TON at $5 is 1 char of integer + 8 decimals = 10
 *  chars total; even a high-precision XBT/USD at $1M would be 7 +
 *  8 = 15. Anything past 32 is either operator typo or hostile
 *  feed; either way we drop the tick. */
const MAX_PRICE_LEN = 32;

/** Parse "6.483000" → `{mantissa: 6483000n, expo: -6}`. Trailing
 *  zeros are preserved (they affect the natural expo; the manager
 *  rescales to a common target). Returns null for malformed input,
 *  non-positive result, or input longer than MAX_PRICE_LEN
 *  (DoS defense — a hostile server sending a million-digit price
 *  string would otherwise pin the event loop on BigInt parse). */
export function parsePositivePrice(s: string): { mantissa: bigint; expo: number } | null {
    if (s.length > MAX_PRICE_LEN) return null;
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const dotIdx = s.indexOf('.');
    let digits: string;
    let expo: number;
    if (dotIdx < 0) {
        digits = s;
        expo = 0;
    } else {
        digits = s.slice(0, dotIdx) + s.slice(dotIdx + 1);
        expo = -(s.length - dotIdx - 1);
    }
    let mantissa: bigint;
    try {
        mantissa = BigInt(digits);
    } catch {
        return null;
    }
    if (mantissa <= 0n) return null;
    return { mantissa, expo };
}
