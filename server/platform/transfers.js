import express from 'express';
import { platformPool } from '../db.js';
import { requireRole } from './auth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// Product links — RETIRED READ-ONLY REMNANT (D14 + owner, 2026-07-16)
//
// This file used to implement the cross-system fragrance TRANSFER (PRD
// FR-XFER-1..10, Phase 4): link an SA oil to an SM fragrance, then send /
// receive / cancel stock between the two systems.
//
// **D14 removed the reason for it to exist.** SA, Scented Merchandise and MUSE
// all draw from ONE shared pool (`sa.products` category OILS — the Fragrance
// Library), so there is no second shelf to move oil to: SM/MUSE production
// consumes directly from the pool at production start. Moving 30 ml from "SA"
// to "SM" is now a distinction without a difference.
//
// **The transfer mechanism was therefore retired** (owner approved 2026-07-16
// after an audit proved it had never been used for real business — all 27
// `platform.stock_transfers` rows were tests: 24 tagged `[xf-regression]` plus
// 3 of the owner's own manual "test" rows). Removed: the SA `/transfers` page,
// the P&O `/transfers-in` page, the send/receive/cancel endpoints (a retired
// mechanism must not keep the ability to move production stock), the link
// create/delete/suggest endpoints (only the removed page used them), and
// `scripts/regression-transfers.js`.
//
// **Deliberately KEPT — do not "finish the cleanup" without checking these:**
//   · `GET /product-links`        — read by `scripts/verify-cutover.cjs`.
//   · `GET /product-links/sm-map` — feeds the "linked to SA oil" badge on the
//                                   SM Stock page (`StockManagement.jsx`).
//   · `platform.product_links` + `platform.stock_transfers` TABLES, and the
//     `transfer_out` / `transfer_cancel_return` types in the `sa.transactions`
//     CHECK — retiring a UI must never rewrite ledger history. The historical
//     rows stay readable (and stay classified in the D15 Oil Usage report).
//
// The 120 links themselves are legacy D10 data describing the OLD sm.products
// FRAGRANCE catalog. Their fate — and this file's — rides with **D14.9**, the
// SM/MUSE catalog reset onto the D14 oil model. Until then the badge is
// harmless decoration and this stays read-only.
// ═══════════════════════════════════════════════════════════════════════

function requireModuleAccess(module) {
  return (req, res, next) => {
    if (!Array.isArray(req.user?.modules) || !req.user.modules.includes(module)) {
      return res.status(403).json({ error: `${module} module access required` });
    }
    next();
  };
}

router.get('/product-links', requireRole('root', 'admin'), async (_req, res) => {
  try {
    const r = await platformPool.query(`SELECT * FROM platform.product_links ORDER BY sa_name`);
    res.json(r.rows);
  } catch (e) {
    console.error('[links/list]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Read-only link map for SM UI badges (any SM user, not just admins):
// which SM fragrances are linked to which SA oil (code/name for display).
router.get('/product-links/sm-map', requireModuleAccess('SM'), async (_req, res) => {
  try {
    const r = await platformPool.query(
      `SELECT sm_product_id, sa_product_id, sa_code, sa_name FROM platform.product_links`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[links/sm-map]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
