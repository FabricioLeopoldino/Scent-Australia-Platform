const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const crypto = require('crypto')

const SCOPES = 'write_draft_orders,read_draft_orders,read_orders,write_orders,read_products,write_products'

// Step 1 — visit /shopify/install?shop=muse-9973.myshopify.com to start OAuth
router.get('/shopify/install', (req, res) => {
  const shop = req.query.shop
  if (!shop) return res.status(400).send('Missing ?shop= parameter')

  const apiKey    = process.env.SM_SHOPIFY_API_KEY
  const redirectUri = `https://${req.headers.host}/shopify/callback`
  const state     = crypto.randomBytes(16).toString('hex')

  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${apiKey}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  res.redirect(authUrl)
})

// Step 2 — Shopify redirects here with a code
router.get('/shopify/callback', async (req, res) => {
  const { shop, code } = req.query
  if (!shop || !code) return res.status(400).send('Missing parameters')

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.SM_SHOPIFY_API_KEY,
        client_secret: process.env.SM_SHOPIFY_API_SECRET,
        code
      })
    })
    const data = await response.json()

    if (data.access_token) {
      console.log(`[shopify-oauth] ACCESS TOKEN FOR ${shop}: ${data.access_token}`)
      res.send(`
        <h2>Shopify OAuth Success</h2>
        <p><strong>Shop:</strong> ${shop}</p>
        <p><strong>Access Token:</strong> <code>${data.access_token}</code></p>
        <p>Copy this token and set it as <strong>SHOPIFY_ACCESS_TOKEN</strong> in your Render environment variables.</p>
        <p>The token is also printed in your Render logs.</p>
      `)
    } else {
      res.status(400).send(`OAuth failed: ${JSON.stringify(data)}`)
    }
  } catch (e) {
    res.status(500).send('Internal server error')
  }
})

module.exports = router
