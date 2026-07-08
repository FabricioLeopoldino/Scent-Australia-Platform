// ============================================================
// Unit Conversion Helper
// Bank stores OILS in mL — display always in L
// RAW_MATERIALS and MACHINES stay in "units" — no conversion
// ============================================================

/**
 * Display stock value with correct unit
 * OILS: mL → L  (divide by 1000, format nicely)
 * Others: show as-is with unit label
 */
export const displayStock = (value, unit) => {
  if (value === null || value === undefined) return '—';
  if (unit === 'mL') {
    const L = value / 1000;
    // Format: up to 3 decimal places, remove trailing zeros
    const formatted = parseFloat(L.toFixed(3)).toLocaleString('en-AU', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 3
    });
    return `${formatted} L`;
  }
  return `${value} ${unit}`;
};

/**
 * Display stock value only (no unit label) — for tables where unit is in header
 * OILS: mL → L rounded to 3dp
 * Others: as-is
 */
export const displayStockValue = (value, unit, decimals = 3) => {
  if (value === null || value === undefined) return '—';
  if (unit === 'mL') {
    const L = value / 1000;
    return parseFloat(L.toFixed(decimals)).toLocaleString('en-AU', {
      minimumFractionDigits: 1,
      maximumFractionDigits: decimals
    });
  }
  return String(value);
};

/**
 * Unit label for display
 * mL → L, others unchanged
 */
export const displayUnit = (unit) => {
  if (unit === 'mL') return 'L';
  return unit;
};

/**
 * Convert mL value to L for display in ReplenishmentDashboard
 * All replenishment values are stored in mL
 */
export const mlToL = (mL, decimals = 3) => {
  if (mL === null || mL === undefined) return null;
  if (mL >= 9990000) return 9999; // overflow sentinel
  const L = mL / 1000;
  return Math.round(L * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

/**
 * Format L value for display — clean number with thousand separator
 * Rounds UP to avoid under-reporting
 */
export const fmtL = (L, decimals = 1) => {
  if (L === null || L === undefined) return '—';
  if (Math.abs(L) >= 9990) return '0';
  const rounded = parseFloat(L.toFixed(decimals));
  return rounded.toLocaleString('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};
