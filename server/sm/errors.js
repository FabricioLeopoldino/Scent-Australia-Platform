// Phase 3b (FR-SM-3): error sanitization for SM responses.
//
// DB/internal errors must never reach clients (schema/SQL leakage — the gap
// SA closed in its v2.6.0). But SM's UX legitimately surfaces business
// errors thrown inside service code (e.g. "Insufficient stock: available
// 120, requested 200" in the Manufacturing Queue) — those pass through an
// allowlist; everything else becomes a generic message and is logged
// server-side with its route context.

const BUSINESS_ERROR_PATTERNS = [
  /^insufficient stock/i,
  /not found$/i,
  /^at least one /i,
  /^only draft /i,
  /^only pending /i,
  /^justification required/i,
  /^password must /i,
  /required$/i,
];

function sanitizeError(e, context = 'sm') {
  const msg = e?.message || '';
  if (BUSINESS_ERROR_PATTERNS.some((re) => re.test(msg))) return msg;
  console.error(`[${context}] Internal error:`, msg);
  return 'Internal server error';
}

module.exports = { sanitizeError };
