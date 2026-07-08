const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, auditLog } = require('../auth')
const { easypostRequest } = require('../services/shipping-service')

router.get('/production-orders/:id/shipping', auth, async (req, res) => {
  try {
    const labels = await query(`SELECT * FROM shipping_labels WHERE production_order_id = $1 ORDER BY created_at DESC`, [req.params.id])
    res.json({ labels: labels.rows, easypost_configured: !!process.env.EASYPOST_API_KEY })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/shipping/rates', auth, async (req, res) => {
  if (!process.env.EASYPOST_API_KEY) return res.json({ configured: false, rates: [] })
  const { to_address_string, weight_kg, length_cm, width_cm, height_cm } = req.body
  try {
    const settingsRes = await query(`SELECT key, value FROM system_settings WHERE key LIKE 'company_%'`)
    const settings = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]))
    const fromAddress = {
      name:    settings.company_name    || 'Scented Merchandise',
      street1: settings.company_street  || '1 Warehouse Lane',
      city:    settings.company_city    || 'Sydney',
      state:   settings.company_state   || 'NSW',
      zip:     settings.company_zip     || '2000',
      country: settings.company_country || 'AU',
      phone:   settings.company_phone   || ''
    }
    const result = await easypostRequest('POST', '/shipments', {
      shipment: {
        to_address: { name: 'Ship To', street1: to_address_string },
        from_address: fromAddress,
        parcel: {
          weight: (parseFloat(weight_kg) || 1) * 35.274,
          length: parseFloat(length_cm) || 30,
          width:  parseFloat(width_cm)  || 20,
          height: parseFloat(height_cm) || 15
        }
      }
    })
    if (result.data.error) return res.status(400).json({ error: result.data.error.message || 'EasyPost error' })
    res.json({ configured: true, shipment_id: result.data.id, rates: result.data.rates || [] })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/shipping/buy', auth, async (req, res) => {
  const { production_order_id, shipment_id, rate_id, carrier, service, rate_amount, currency } = req.body
  if (!production_order_id || !shipment_id || !rate_id) return res.status(400).json({ error: 'Missing required fields' })
  try {
    const result = await easypostRequest('POST', `/shipments/${shipment_id}/buy`, { rate: { id: rate_id } })
    if (result.data.error) return res.status(400).json({ error: result.data.error.message || 'EasyPost error' })
    const label = await query(
      `INSERT INTO shipping_labels (production_order_id, carrier, service, tracking_number, label_url, shipment_id, rate, currency, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING *`,
      [production_order_id, carrier, service, result.data.tracking_code || null,
       result.data.postage_label?.label_url || null, shipment_id, rate_amount, currency || 'AUD', req.user.id]
    )
    await auditLog(req.user.id, 'shipping_label_created', 'shipping_label', label.rows[0].id,
      `${carrier} label for order #${production_order_id}`, { tracking: result.data.tracking_code })
    res.status(201).json(label.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/shipping/manual', auth, async (req, res) => {
  const { production_order_id, carrier, service, tracking_number, notes } = req.body
  if (!production_order_id) return res.status(400).json({ error: 'production_order_id required' })
  try {
    const label = await query(
      `INSERT INTO shipping_labels (production_order_id, carrier, service, tracking_number, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
      [production_order_id, carrier || null, service || null, tracking_number || null, notes || null, req.user.id]
    )
    await auditLog(req.user.id, 'shipping_label_manual', 'shipping_label', label.rows[0].id,
      `Manual label for order #${production_order_id}`, { carrier, tracking_number })
    res.status(201).json(label.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.delete('/shipping/:id', auth, async (req, res) => {
  try {
    const existing = await query(`SELECT * FROM shipping_labels WHERE id = $1`, [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })
    const lbl = existing.rows[0]
    if (lbl.shipment_id && process.env.EASYPOST_API_KEY) {
      try { await easypostRequest('POST', `/shipments/${lbl.shipment_id}/refund`, {}) } catch {}
    }
    await query(`UPDATE shipping_labels SET status = 'voided' WHERE id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
