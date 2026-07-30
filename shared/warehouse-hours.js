// Warehouse operating window — the ONLY place this schedule is defined.
//
// Melbourne warehouse (2/600 Lorimer St, VIC 3207) works 07:30–16:00, Mon–Fri.
// The window here is 06:30–17:00 Mon–Fri: a safety margin the owner set
// (2026-07-31) because the person entering orders sometimes starts before the
// shift and leaves after it.
//
// WHY THIS IS BILLED CODE: the Neon keep-alive ping in server/sa/index.js is
// gated on this function. Neon auto-suspends when idle and charges by CU-hour,
// so every hour inside this window is compute we pay for whether or not anyone
// is logged in. Weekends are excluded deliberately — nobody works them.
// Do not widen this without a real business reason.

export const WAREHOUSE_TZ = 'Australia/Melbourne';
const START_MINUTE = 6 * 60 + 30; // 06:30
const END_MINUTE = 17 * 60;       // 17:00 (exclusive)

export function withinWarehouseHours(now = new Date()) {
  // hourCycle 'h23' matters: with hour12:false some locales render midnight as
  // "24" rather than "00", which would silently break the comparison.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: WAREHOUSE_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minuteOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return minuteOfDay >= START_MINUTE && minuteOfDay < END_MINUTE;
}
