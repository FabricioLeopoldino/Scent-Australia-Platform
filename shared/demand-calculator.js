// The demand calculator — the one place that turns sales history and a
// Salesforce forecast into a daily rate.
//
// WHY THIS IS A MODULE (2026-09-14). It lived inside the replenishment endpoint,
// which meant the only way to ask "what would this have said in May?" was to
// rewrite it somewhere else. That was tried, and the copy was wrong: it reported
// 171 critical products where the real code reported 112. A backtest built on a
// re-implementation measures the re-implementation.
//
// So it moved out unchanged. The single addition is the `asOf` argument, which
// the endpoint does not pass. Every line below is the production arithmetic,
// byte-for-byte, and the replenishment regression suites are what prove it.

export const calcSmartDemand = (dailyEntries, forecastDaily, asOf = null) => {
  // ── Stream 1: Retail (Shopify / transaction history)
  // Uses weighted average: last 7 days (60%) vs days 8-30 (40%)
  // This detects trending products (growing or declining demand).
  // Falls back to flat average when only one period has data.
  const PERIOD_DAYS = 30;
  const RECENT_DAYS = 7;
  const RECENT_WEIGHT = 0.6;
  const OLDER_WEIGHT  = 0.4;

  let retailAvg = 0, retailPeak = 0, retailMin = 0, cleanDays = 0, totalSold30d = 0;
  let meanVol = 0, stddev = 0;
  let recentEntries = [], olderEntries = [];
  let recentAvg = 0, olderAvg = 0;
  if (dailyEntries && dailyEntries.length > 0) {
    // `asOf` exists so a backtest can ask what this would have said on a past
    // date. The endpoint passes nothing and gets today in Sydney, exactly as
    // before — the parameter changes no production behaviour.
    const todayStr = asOf || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const cutoffDate = new Date(todayStr);
    cutoffDate.setDate(cutoffDate.getDate() - RECENT_DAYS);
    const recentCutoffStr = cutoffDate.toISOString().slice(0, 10);

    recentEntries = dailyEntries.filter(e => e.date >= recentCutoffStr);
    olderEntries  = dailyEntries.filter(e => e.date <  recentCutoffStr);
    const allVolumes    = dailyEntries.map(e => e.volume);

    totalSold30d = allVolumes.reduce((a, b) => a + b, 0);
    cleanDays    = allVolumes.length;
    const freq   = cleanDays / PERIOD_DAYS;

    // Weighted average blending recent trend with historical baseline
    let weightedDailyAvg;
    if (recentEntries.length > 0 && olderEntries.length > 0) {
      recentAvg = recentEntries.reduce((a, e) => a + e.volume, 0) / RECENT_DAYS;
      olderAvg  = olderEntries.reduce((a, e) => a + e.volume, 0) / (PERIOD_DAYS - RECENT_DAYS);
      weightedDailyAvg = recentAvg * RECENT_WEIGHT + olderAvg * OLDER_WEIGHT;
    } else {
      // Only one period has data: use flat average (no trend to detect)
      weightedDailyAvg = totalSold30d / PERIOD_DAYS;
    }

    retailAvg  = weightedDailyAvg;

    meanVol  = totalSold30d / PERIOD_DAYS; // true daily rate over the period
    const zeroDays = Math.max(0, PERIOD_DAYS - cleanDays); // guard: SQL may return >30 sale-days
    const sumSqDiff = allVolumes.reduce((sum, v) => sum + Math.pow(v - meanVol, 2), 0)
                    + zeroDays * Math.pow(meanVol, 2); // (0 − mean)² for zero-sale days
    const variance  = sumSqDiff / PERIOD_DAYS;
    stddev    = Math.sqrt(variance);
    retailPeak = meanVol + 1.5 * stddev;

    // Physical cap: the conservative daily retail rate cannot exceed the
    // single highest observed day. For sparse products (few cleanDays),
    // the stddev can theoretically exceed the max real observation — this
    // prevents the formula from producing a statistically impossible result.
    const maxObservedDay = Math.max(...allVolumes);
    if (retailPeak > maxObservedDay) retailPeak = maxObservedDay;

    // Sparse product cap: with few sale days, zeroDays dominate stddev
    // making retailPeak unrealistically high (e.g. 1122 mL/d from 2 sale days).
    // Cap relative to the true mean to keep conservative scenario grounded.
    // < 5 sale days → cap at 2× mean;  5–14 sale days → cap at 3× mean.
    if      (cleanDays < 5  && meanVol > 0) retailPeak = Math.min(retailPeak, meanVol * 2);
    else if (cleanDays < 15 && meanVol > 0) retailPeak = Math.min(retailPeak, meanVol * 3);

    // Optimistic minimum: normalize by sales frequency so sporadic products
    // don't appear to have a high minimum daily rate.
    // e.g. min sale of 10L on 1/30 days → 0.33 L/day, not 10 L/day.
    retailMin = Math.min(...allVolumes) * (cleanDays / PERIOD_DAYS);
  }

  // ── Stream 2: B2B (Salesforce forecast)
  const b2bDaily = (forecastDaily != null && forecastDaily > 0) ? forecastDaily : 0;

  // ── Data confidence (based on retail history depth)
  let dataConfidence;
  if      (cleanDays >= 25) dataConfidence = 'high';
  else if (cleanDays >= 15) dataConfidence = 'medium';
  else if (cleanDays >= 5)  dataConfidence = 'low';
  else if (cleanDays > 0)   dataConfidence = 'very_low';
  else if (b2bDaily > 0)    dataConfidence = 'forecast_only';
  else                      dataConfidence = 'no_data';

  // ── 3 Scenarios: retail stream + B2B stream (separated, not blended)
  // No artificial floor — products with zero demand correctly show infinite days of stock.
  // Division-by-zero is handled in todays() below.

  // Trend multiplier: se últimos 7d acelerando ou desacelerando vs histórico
  // amortecido em ±25% para não reagir excessivamente a ruído de curto prazo
  let trendMultiplier = 1.0;
  if (recentEntries && recentEntries.length > 0 &&
      olderEntries  && olderEntries.length  > 0 &&
      olderAvg > 0) {
    const ratio = recentAvg / olderAvg;
    trendMultiplier = Math.min(1.25, Math.max(0.75, ratio));
  }

  // CV-based dynamic buffer (usado abaixo na ordem, exposto via return)
  const cv = meanVol > 0 ? stddev / meanVol : 1;
  // Cap buffer by data confidence: sparse products always have high CV (many zeros),
  // but ordering 75 buffer days based on 2 data points is statistically unsound.
  const bufferCap = cleanDays >= 25 ? 75 : cleanDays >= 15 ? 60 : cleanDays >= 5 ? 45 : 30;
  const dynamicBufferDays = Math.round(Math.min(bufferCap, Math.max(30, 30 + (45 * Math.min(cv, 2) / 2))));

  const conservative = retailPeak                    + b2bDaily;
  const expected     = (retailAvg * trendMultiplier) + b2bDaily;
  const optimistic   = retailMin                     + (b2bDaily * 0.7);

  // backward-compat: avgDailyDemand = expected scenario
  const avgDailyDemand = expected;

  return {
    avgDailyDemand,          // kept for backward compat (StockManagement)
    retailDailyAvg:  retailAvg,
    retailDailyPeak: retailPeak,
    retailDailyMin:  retailMin,
    b2bDaily,
    scenarios: { conservative, expected, optimistic },
    trendMultiplier,
    dynamicBufferDays,
    cleanDays,
    totalSold30d,
    dataConfidence,
    spikesRemoved: 0
  };
};
