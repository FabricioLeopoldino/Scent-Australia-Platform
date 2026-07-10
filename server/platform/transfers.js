import express from 'express';
import { platformPool, saPool, smPool } from '../db.js';
import { requireRole, auditLog } from './auth.js';
// SM's single stock-mutation path (CJS interop) — writes sm.transactions with
// balance_after and enqueues the Shopify inventory adjust for published items.
import smStockService from '../sm/services/stock-service.js';
const { adjustProductStock } = smStockService;

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// Cross-system fragrance transfers — PRD FR-XFER-1..10 (Phase 4)
//
// Model (mirrors the battle-tested SA Tech Stock pattern):
//   SEND (SA side)    — atomic: FOR UPDATE on sa product, guard qty ≤ stock,
//                       debit currentStock + stockBoxes (FR-XFER-10), write
//                       sa.transactions 'transfer_out' with balance_after,
//                       insert platform.stock_transfers 'in_transit'.
//   RECEIVE (SM side) — atomic: credit sm product via SM's adjustProductStock
//                       ('transfer_in'), partial requires discrepancy_reason,
//                       transfer → 'received'.
//   CANCEL (SA side)  — atomic symmetric reversal ('transfer_cancel_return').
//
// Module gating: send/cancel need SA access, receive needs SM access
// (endpoints live under /api/platform — outside requireModule mounts).
// ═══════════════════════════════════════════════════════════════════════

function requireModuleAccess(module) {
  return (req, res, next) => {
    if (!Array.isArray(req.user?.modules) || !req.user.modules.includes(module)) {
      return res.status(403).json({ error: `${module} module access required` });
    }
    next();
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── Product links (FR-XFER-1) ─────────────────────────────────────────────

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

// Pickers + naive name-match suggestions
router.get('/product-links/suggest', requireRole('root', 'admin'), async (req, res) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    // No tight LIMIT: the pickers must show the FULL catalogs (owner-reported:
    // LIMIT 40 hid most SA oils and made unlinked SM fragrances "disappear").
    // ~270 oils / ~130 fragrances — trivial payloads; 1000 is a sanity cap.
    const saProducts = (
      await saPool.query(
        `SELECT id, "productCode" AS code, name, "currentStock" AS stock, unit
         FROM products WHERE category = 'OILS' AND status = 'active'
           AND (name ILIKE $1 OR "productCode" ILIKE $1 OR id ILIKE $1)
         ORDER BY name LIMIT 1000`,
        [q]
      )
    ).rows;
    const smProducts = (
      await smPool.query(
        `SELECT id, product_code AS code, name, current_stock AS stock, unit
         FROM products WHERE category = 'FRAGRANCE' AND COALESCE(archived, false) = false
           AND (name ILIKE $1 OR product_code ILIKE $1)
         ORDER BY name LIMIT 1000`,
        [q]
      )
    ).rows;

    const linked = await platformPool.query(`SELECT sa_product_id, sm_product_id FROM platform.product_links`);
    const linkedSm = new Set(linked.rows.map((r) => r.sm_product_id));

    // D10: an SA oil may already be linked and still be suggested for another
    // unlinked SM fragrance (aliases) — only the SM side filters out.
    const suggestions = [];
    for (const sa of saProducts) {
      const match = smProducts.find((sm) => !linkedSm.has(sm.id) && norm(sm.name) === norm(sa.name));
      if (match) suggestions.push({ sa, sm: match, score: 1 });
    }

    res.json({ sa_products: saProducts, sm_products: smProducts, suggestions });
  } catch (e) {
    console.error('[links/suggest]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/product-links', requireRole('root', 'admin'), async (req, res) => {
  try {
    const { sa_product_id, sm_product_id } = req.body || {};
    if (!sa_product_id || !sm_product_id) {
      return res.status(400).json({ error: 'sa_product_id and sm_product_id required' });
    }

    const sa = await saPool.query(
      `SELECT id, "productCode" AS code, name, category FROM products WHERE id = $1`,
      [sa_product_id]
    );
    if (!sa.rows[0]) return res.status(404).json({ error: 'SA product not found' });
    if (sa.rows[0].category !== 'OILS') return res.status(400).json({ error: 'SA product must be a fragrance oil (OILS)' });

    const sm = await smPool.query(
      `SELECT id, product_code AS code, name, category FROM products WHERE id = $1`,
      [parseInt(sm_product_id)]
    );
    if (!sm.rows[0]) return res.status(404).json({ error: 'SM product not found' });
    if (sm.rows[0].category !== 'FRAGRANCE') return res.status(400).json({ error: 'SM product must be a FRAGRANCE' });

    const link = await platformPool.query(
      `INSERT INTO platform.product_links (sa_product_id, sm_product_id, sa_code, sa_name, sm_code, sm_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [sa.rows[0].id, sm.rows[0].id, sa.rows[0].code, sa.rows[0].name, sm.rows[0].code, sm.rows[0].name, req.user.id]
    );
    await auditLog(req.user.id, 'product_link_created', 'product_link', link.rows[0].id, {
      sa: sa.rows[0].name, sm: sm.rows[0].name,
    });
    res.status(201).json(link.rows[0]);
  } catch (e) {
    // D10: only the SM side is unique now (an SA oil may feed many SM aliases)
    if (e.code === '23505') return res.status(409).json({ error: 'That SM fragrance is already linked to an SA oil' });
    console.error('[links/create]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/product-links/:id', requireRole('root', 'admin'), async (req, res) => {
  try {
    const r = await platformPool.query(`DELETE FROM platform.product_links WHERE id = $1 RETURNING sa_name`, [
      parseInt(req.params.id),
    ]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Link not found' });
    await auditLog(req.user.id, 'product_link_deleted', 'product_link', parseInt(req.params.id), { sa: r.rows[0].sa_name });
    res.json({ success: true });
  } catch (e) {
    console.error('[links/delete]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Transfers (FR-XFER-2..8) ─────────────────────────────────────────────

router.get('/transfers', async (req, res) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND t.status = $${params.length}`;
    }
    const r = await platformPool.query(
      `SELECT t.*, su.name AS sent_by_name, ru.name AS received_by_name,
              l.sa_name, l.sa_code, l.sm_name, l.sm_code
       FROM platform.stock_transfers t
       LEFT JOIN platform.users su ON su.id = t.sent_by
       LEFT JOIN platform.users ru ON ru.id = t.received_by
       LEFT JOIN platform.product_links l ON l.id = t.product_link_id
       WHERE ${where}
       ORDER BY t.sent_at DESC LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[transfers/list]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SEND — SA side (FR-XFER-2 + FR-XFER-10)
router.post('/transfers', requireRole('root', 'admin'), requireModuleAccess('SA'), async (req, res) => {
  const client = await saPool.connect();
  try {
    const { product_link_id, quantity_ml, notes } = req.body || {};
    const qty = parseFloat(quantity_ml);
    if (!product_link_id || !qty || qty <= 0) {
      return res.status(400).json({ error: 'product_link_id and positive quantity_ml required' });
    }

    const linkRes = await platformPool.query(`SELECT * FROM platform.product_links WHERE id = $1`, [product_link_id]);
    if (!linkRes.rows[0]) return res.status(404).json({ error: 'Product link not found' });
    const link = linkRes.rows[0];

    await client.query('BEGIN');

    const prodRes = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [link.sa_product_id]);
    if (!prodRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SA product not found' });
    }
    const product = prodRes.rows[0];
    const current = parseFloat(product.currentStock) || 0;
    if (qty > current) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient stock: available ${current} mL, requested ${qty} mL` });
    }

    const newStock = current - qty;
    await client.query(`UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`, [
      newStock,
      Math.floor(newStock / (product.unitPerBox || 1)),
      product.id,
    ]);

    const tx = await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
       VALUES ($1,$2,$3,$4,'transfer_out',$5,$6,$7,$8,$9) RETURNING id`,
      [
        product.id, product.productCode || product.tag, product.name, product.category,
        qty, product.unit || 'mL', newStock,
        `Transfer to Scented Merchandise — ${link.sm_name}${notes ? ` | ${notes}` : ''}`,
        req.user.id,
      ]
    );

    const transfer = await client.query(
      `INSERT INTO platform.stock_transfers
         (product_link_id, direction, sa_product_id, sm_product_id, quantity_ml, status, notes, sent_by, sa_tx_out_id)
       VALUES ($1,'SA_TO_SM',$2,$3,$4,'in_transit',$5,$6,$7) RETURNING *`,
      [link.id, link.sa_product_id, link.sm_product_id, qty, notes || null, req.user.id, String(tx.rows[0].id)]
    );

    await client.query('COMMIT');
    await auditLog(req.user.id, 'transfer_sent', 'stock_transfer', transfer.rows[0].id, {
      fragrance: link.sa_name, quantity_ml: qty, sa_balance_after: newStock,
    });
    // Enriched for the send-confirmation modal (names + resulting balance)
    res.status(201).json({
      ...transfer.rows[0],
      sa_balance_after: newStock,
      sa_name: link.sa_name, sa_code: link.sa_code,
      sm_name: link.sm_name, sm_code: link.sm_code,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[transfers/send]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// RECEIVE — SM side (FR-XFER-3/4)
router.post('/transfers/:id/receive', requireModuleAccess('SM'), async (req, res) => {
  const client = await smPool.connect();
  try {
    const { received_qty_ml, discrepancy_reason } = req.body || {};
    const transferId = parseInt(req.params.id);

    await client.query('BEGIN');

    const tr = await client.query(
      `SELECT * FROM platform.stock_transfers WHERE id = $1 FOR UPDATE`,
      [transferId]
    );
    if (!tr.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer not found' });
    }
    const transfer = tr.rows[0];
    if (transfer.status !== 'in_transit') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Transfer is already ${transfer.status}` });
    }

    const sentQty = parseFloat(transfer.quantity_ml);
    const receivedQty = received_qty_ml === undefined ? sentQty : parseFloat(received_qty_ml);
    if (!(receivedQty >= 0) || receivedQty > sentQty + 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'received_qty_ml must be between 0 and the sent quantity' });
    }
    if (receivedQty < sentQty - 0.001 && !discrepancy_reason?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Justification required when quantity received is less than sent' });
    }

    const tq = (text, params) => client.query(text, params);
    await tq(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [transfer.sm_product_id]);
    let smTxId = null;
    if (receivedQty > 0) {
      await adjustProductStock(
        transfer.sm_product_id, receivedQty, 'transfer_in',
        `Transfer from Scent Stock Manager (transfer #${transferId})${discrepancy_reason ? ` | short: ${discrepancy_reason}` : ''}`,
        req.user.id, null, null, tq
      );
      const lastTx = await tq(
        `SELECT id FROM transactions WHERE product_id = $1 AND type = 'transfer_in' ORDER BY id DESC LIMIT 1`,
        [transfer.sm_product_id]
      );
      smTxId = lastTx.rows[0]?.id || null;
    }

    const updated = await tq(
      `UPDATE platform.stock_transfers
       SET status = 'received', received_qty_ml = $1, discrepancy_reason = $2,
           received_by = $3, received_at = NOW(), sm_tx_in_id = $4
       WHERE id = $5 RETURNING *`,
      [receivedQty, discrepancy_reason || null, req.user.id, smTxId, transferId]
    );

    await client.query('COMMIT');
    await auditLog(req.user.id, 'transfer_received', 'stock_transfer', transferId, {
      received_qty_ml: receivedQty, sent_qty_ml: sentQty, discrepancy_reason: discrepancy_reason || null,
    });
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[transfers/receive]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// CANCEL — SA side symmetric reversal (FR-XFER-5)
router.post('/transfers/:id/cancel', requireRole('root', 'admin'), requireModuleAccess('SA'), async (req, res) => {
  const client = await saPool.connect();
  try {
    const transferId = parseInt(req.params.id);
    const reason = req.body?.reason || null;

    await client.query('BEGIN');

    const tr = await client.query(`SELECT * FROM platform.stock_transfers WHERE id = $1 FOR UPDATE`, [transferId]);
    if (!tr.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer not found' });
    }
    const transfer = tr.rows[0];
    if (transfer.status !== 'in_transit') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Only in-transit transfers can be cancelled (this one is ${transfer.status})` });
    }

    const qty = parseFloat(transfer.quantity_ml);
    const prodRes = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [transfer.sa_product_id]);
    const product = prodRes.rows[0];
    const newStock = (parseFloat(product.currentStock) || 0) + qty;

    await client.query(`UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`, [
      newStock, Math.floor(newStock / (product.unitPerBox || 1)), product.id,
    ]);
    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
       VALUES ($1,$2,$3,$4,'transfer_cancel_return',$5,$6,$7,$8,$9)`,
      [
        product.id, product.productCode || product.tag, product.name, product.category,
        qty, product.unit || 'mL', newStock,
        `Transfer #${transferId} cancelled — returned to stock${reason ? ` | ${reason}` : ''}`,
        req.user.id,
      ]
    );

    const updated = await client.query(
      `UPDATE platform.stock_transfers SET status = 'cancelled', discrepancy_reason = $1 WHERE id = $2 RETURNING *`,
      [reason, transferId]
    );

    await client.query('COMMIT');
    await auditLog(req.user.id, 'transfer_cancelled', 'stock_transfer', transferId, {
      quantity_ml: qty, sa_balance_after: newStock, reason,
    });
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[transfers/cancel]', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
