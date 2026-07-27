#!/usr/bin/env node
// Guards the light-mode text safety-net in src/sm/sm.css (added 2026-07-27).
// The fix relies on ONE invariant: the broad catch-all selector
//   [style*="rgba(232, 234, 242"]:not([style*="background"])
// must appear in source order BEFORE the specific alpha-tier rules
//   [style*="rgba(232, 234, 242, 0.4)"] ...
// Same specificity → source order decides. If a future edit removes the
// catch-all, unlisted alphas render as invisible light-on-cream again.
// If it's moved AFTER the tiers, known alphas lose their hierarchy (all flatten
// to the catch-all value). This test fails on either regression.
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'sm', 'sm.css'), 'utf8');

const catchAll = 'html:not(.dark) .sm-scope [style*="rgba(232, 234, 242"]:not([style*="background"])';
const firstTier = '[style*="rgba(232, 234, 242, 0.4)"]';

const iCatch = css.indexOf(catchAll);
const iTier = css.indexOf(firstTier);

let failed = false;
function check(cond, msg) { if (!cond) { console.error('  ✗ ' + msg); failed = true; } else { console.log('  ✓ ' + msg); } }

console.log('light-mode safety-net gate:');
check(iCatch !== -1, 'catch-all selector present');
check(iTier !== -1, 'specific alpha tier present');
check(iCatch !== -1 && iTier !== -1 && iCatch < iTier, 'catch-all comes BEFORE the specific tiers (source order)');

if (failed) { console.error('\nFAIL — light-mode text repaint fragility reintroduced.'); process.exit(1); }
console.log('\nPASS');
