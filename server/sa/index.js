// ═══════════════════════════════════════════════════════════════════════
// SA Scent Stock Manager — mounted as the platform's /api/sa router.
// Mechanical conversion per PRD Appendix A (Phase 2b):
//   - bootstrap (app/CORS/json/listen), local auth, and SPA catch-all removed
//   - app.<verb>( → router.<verb>( with the /api path prefix stripped
//   - webhook handler exported as saWebhookHandler (platform receiver calls it)
//   - startup migrations exported as runSaStartupMigrations
//   - pool → saPool from ../db.js (platform DB, search_path=sa,public)
// SQL and business logic are byte-for-byte identical to production.
// ═══════════════════════════════════════════════════════════════════════

import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// Platform DB with search_path=sa,public (PRD §7.3) — unqualified SA queries
// resolve to schema sa with zero SQL changes. UTC type parser lives in db.js.
import { saPool as pool } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// ========================================================================
// IN-MEMORY WEBHOOK LOCK
// Prevents race conditions when two webhook requests arrive simultaneously
// (before either has written to the DB). This is the first line of defense.
// ========================================================================
const processingOrders = new Set();

// ========================================================================
// MULTER
// ========================================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Path edit (documented deviation): uploads live at platform/uploads
    const uploadDir = join(__dirname, '../../uploads');
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  }
});

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'text/csv',                                                           // .csv
  'application/pdf',                                                    // .pdf
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',               // images
]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    }
  }
});

// /uploads static serving moved to the platform server (server/index.js).

// ========================================================================
// HELPER: Create product in Shopify automatically
// ========================================================================
async function createProductInShopify(product) {
  // Support both SHOPIFY_ACCESS_TOKEN (new) and SHOPIFY_API_PASSWORD (legacy fallback)
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
  if (!process.env.SHOPIFY_STORE_NAME || !accessToken) {
    throw new Error('Shopify credentials not configured. Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN in environment variables.');
  }

  const shopifySkus = parseJSONB(product.shopifySkus);
  const productName = product.name;

  // Scent Australia structure: one separate Shopify product per SKU type (not variants of one product)
  const variantDetails = {
    'SA_CA':    { suffix: 'Oil Cartridge (400ml)',      price: '165.00',  weight: 400  },
    'SA_HF':    { suffix: '-500ML Oil Refill Bottle',   price: '150.00',  weight: 500  },
    'SA_CDIFF': { suffix: 'Oil Refill (700ml)',          price: '275.00',  weight: 700  },
    'SA_1L':    { suffix: '1L Oil Refill Bottle',       price: '218.90',  weight: 1000 },
    'SA_PRO':   { suffix: '-1L Oil Refill Pro Bottle',  price: '275.00',  weight: 1000 },
    'SA_DM':    { suffix: '',                           price: '0.00',    weight: 0    },
    'SA_MAC':   { suffix: '',                           price: '0.00',    weight: 0    },
    'SA_RM':    { suffix: '',                           price: '0.00',    weight: 0    },
  };

  const productTypeMap = {
    'OILS': 'Fragrance Oil',
    'SA_SCENTED_PRODUCTS': 'Scented Product',
    'SCENT_MACHINES': 'Diffuser Machine',
    'MACHINES_SPARES': 'Spare Part',
    'RAW_MATERIALS': 'Raw Material',
  };
  const shopifyProductType = productTypeMap[product.category] || 'Product';

  // For SA_SCENTED_PRODUCTS, pre-fetch the container that owns this SKU so we get
  // its retail price and exact volume. The productCode ends with `_NNNNN` after the
  // container's sku_prefix, so we strip the trailing _NNNNN to find the container.
  let scentedContainer = null;
  if (product.category === 'SA_SCENTED_PRODUCTS' && product.productCode) {
    const prefix = product.productCode.replace(/_\d+$/, '');
    try {
      const cRes = await pool.query(
        `SELECT price, volume_ml FROM scented_containers WHERE sku_prefix = $1 LIMIT 1`,
        [prefix]
      );
      if (cRes.rows.length > 0) scentedContainer = cRes.rows[0];
    } catch (e) {
      console.warn('Could not load scented container:', e.message);
    }
  }

  // Derive details on the fly for scented products (since each container has its own volume + price)
  const getDetails = (type) => {
    if (variantDetails[type]) return variantDetails[type];
    if (product.category === 'SA_SCENTED_PRODUCTS') {
      // Prefer container metadata; fall back to regex on the product name
      const volMatch = (productName || '').match(/(\d+)\s*ml/i);
      const weight = scentedContainer?.volume_ml != null
        ? parseFloat(scentedContainer.volume_ml)
        : (volMatch ? parseInt(volMatch[1]) : 0);
      const price = scentedContainer?.price != null
        ? parseFloat(scentedContainer.price).toFixed(2)
        : '0.00';
      return { suffix: '', price, weight };
    }
    return null;
  };

  // For scented products, fetch fragrance metadata from the group so we can build a rich body_html
  let fragranceMeta = null;
  if (product.category === 'SA_SCENTED_PRODUCTS' && product.group_id) {
    try {
      const gRes = await pool.query(
        `SELECT fragrance_description, fragrance_type, fragrance_notes
         FROM scented_product_groups WHERE id = $1`,
        [product.group_id]
      );
      if (gRes.rows.length > 0) fragranceMeta = gRes.rows[0];
    } catch (e) {
      console.warn('Could not load scented group metadata:', e.message);
    }
  }

  // HTML-escape so user-typed text can't break the body_html
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Convert plaintext line breaks to <br>
  const lines = (s) => esc(s).replace(/\r?\n/g, '<br>');

  const buildBodyHtml = (productTitle) => {
    const parts = [`<p>${esc(productTitle)}</p>`];
    if (fragranceMeta) {
      if (fragranceMeta.fragrance_description) {
        parts.push(`<p>${lines(fragranceMeta.fragrance_description)}</p>`);
      }
      if (fragranceMeta.fragrance_type) {
        parts.push(`<p><strong>Fragrance Type:</strong> ${esc(fragranceMeta.fragrance_type)}</p>`);
      }
      if (fragranceMeta.fragrance_notes) {
        parts.push(`<p><strong>Notes:</strong> ${lines(fragranceMeta.fragrance_notes)}</p>`);
      }
    }
    parts.push(`<p>Product Code: ${esc(product.productCode || '')}</p>`);
    return parts.join('');
  };

  const url = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-01/products.json`;
  const added = [];
  const failed = [];

  for (const [type, sku] of Object.entries(shopifySkus)) {
    if (!sku) continue;
    const details = getDetails(type);
    if (!details) continue;

    const productTitle = details.suffix ? `${productName} ${details.suffix}` : productName;
    const newShopifyProduct = {
      product: {
        title: productTitle,
        body_html: buildBodyHtml(productTitle),
        vendor: product.supplier || 'Scent Australia',
        product_type: shopifyProductType,
        status: 'draft',
        tags: [product.category, product.tag].filter(Boolean).join(', '),
        variants: [{
          sku,
          price: details.price,
          weight: details.weight,
          weight_unit: 'g',
          inventory_management: null,
          inventory_policy: 'continue'
        }]
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify(newShopifyProduct)
    });

    if (response.ok) {
      const data = await response.json();
      added.push({ type, sku, title: productTitle, shopifyId: data.product.id });
      console.log(`✅ Created Shopify product "${productTitle}" (SKU: ${sku})`);
    } else {
      const errText = await response.text();
      failed.push({ type, sku, error: errText });
      console.error(`❌ Failed to create Shopify product for SKU ${sku}:`, errText);
    }
  }

  return { added, failed };
}

// ========================================================================
// HELPER FUNCTIONS
// ========================================================================

const parseJSONB = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }
  return fallback;
};

// Auto-generate SKUs for OILS
const generateAutoSkus = (category, baseNumber) => {
  const paddedNum = String(baseNumber).padStart(5, '0');
  
  if (category === 'OILS') {
    return {
      SA_CA: `SA_CA_${paddedNum}`,
      SA_1L: `SA_1L_${paddedNum}`,
      SA_CDIFF: `SA_CDIFF_${paddedNum}`,
      SA_PRO: `SA_PRO_${paddedNum}`,
      SA_HF: `SA_HF_${paddedNum}`
    };
  }
  
  if (category === 'RAW_MATERIALS') {
    return {
      SA_RM: `SA_RM_${paddedNum}`
    };
  }
  
  if (category === 'MACHINES_SPARES') {
    return {
      SA_MAC: `SA_MAC_${paddedNum}`
    };
  }

  if (category === 'SCENT_MACHINES') {
    return {
      SA_DM: `SA_DM_${paddedNum}`
    };
  }

  return {};
};

// Next available SKU number for a scented product prefix (SA_RS, SA_RD, SA_RR, etc.)
async function nextScentedSkuNum(client, prefix) {
  const rows = await client.query(
    `SELECT "productCode" FROM products WHERE "productCode" LIKE $1`,
    [`${prefix}_%`]
  );
  let max = 0;
  for (const r of rows.rows) {
    const parts = r.productCode.split('_');
    const n = parseInt(parts[parts.length - 1]);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// ========================================================================
// HEALTH CHECK — Smart (não acorda o Neon fora do horário comercial)
// ========================================================================
router.get('/health', async (req, res) => {
  const now = new Date();

  // Horário de Sydney (AEDT = UTC+11 / AEST = UTC+10)
  const sydneyDate = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const sydneyHour = sydneyDate.getHours();
  const sydneyDay  = sydneyDate.getDay(); // 0 = Dom, 6 = Sab

  const isWeekday      = sydneyDay >= 1 && sydneyDay <= 5;
  const isBusinessHour = sydneyHour >= 7 && sydneyHour < 17; // 07:00–17:00 Sydney
  const isBusinessTime = isWeekday && isBusinessHour;

  // Fora do horário comercial → responde sem query no banco (Neon não é acordado)
  if (!isBusinessTime) {
    return res.json({
      status: 'ok',
      message: 'Service active (off-hours — DB not queried)',
      timestamp: now.toISOString(),
      businessHours: false
    });
  }

  // Dentro do horário → verifica o banco normalmente
  try {
    const result = await pool.query('SELECT NOW() as now, current_database() as db');
    res.json({
      status: 'ok',
      message: 'Service active',
      timestamp: result.rows[0].now,
      database: result.rows[0].db,
      businessHours: true
    });
  } catch (error) {
    res.status(503).json({ status: 'error', error: error.message });
  }
});

// ========================================================================
// AUTH — removed (Appendix A step 4). The platform owns login/JWT and
// supplies req.user; role checks below keep reading req.user.role untouched.
// ========================================================================

// ========================================================================
// USERS
// ========================================================================
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, role, created_at, must_change_password FROM users ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

router.post('/users', async (req, res) => {
  try {
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Only root can create users' });
    }

    const { name, role } = req.body;

    const validRoles = ['user', 'admin', 'root', 'technician'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const existing = await pool.query('SELECT id FROM users WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const tempPassword = generateTempPassword();
    const hashedPassword = bcrypt.hashSync(tempPassword, 10);
    const result = await pool.query(
      `INSERT INTO users (name, password, role, must_change_password)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, name, role, created_at, must_change_password`,
      [name, hashedPassword, role || 'user']
    );

    res.json({ ...result.rows[0], tempPassword });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Only root can delete users' });
    }

    const userId = parseInt(req.params.id);

    const target = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].role === 'root') {
      return res.status(403).json({ error: 'Cannot delete root user' });
    }

    // Nullify FK references before deleting so audit history is preserved
    await pool.query('UPDATE transactions SET user_id = NULL WHERE user_id = $1', [userId]);
    await pool.query('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/users/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    const userId = parseInt(req.params.id);
    const isChangingOwn = req.user.id === userId;

    if (!isChangingOwn && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Only root can change other users\' passwords' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      'UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2 RETURNING id',
      [hashedPassword, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Only root can reset passwords' });
    }

    const tempPassword = generateTempPassword();
    const hashedDefault = bcrypt.hashSync(tempPassword, 10);
    await pool.query(
      'UPDATE users SET password = $1, must_change_password = TRUE WHERE id = $2',
      [hashedDefault, userId]
    );

    res.json({ success: true, tempPassword });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// PRODUCTS - WITH AUTO SKU MAPPING & SEQUENTIAL ORDERING
// ========================================================================
router.get('/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    
    if (category && category !== 'ALL') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR "productCode" ILIKE $${params.length} OR tag ILIKE $${params.length})`;
    }
    
    // ✅ Sequential ordering
    query += ' ORDER BY tag';
    
    const [result, posResult] = await Promise.all([
      pool.query(query, params),
      pool.query(`SELECT id, product_id, order_number, quantity, quantity_received, supplier, status, notes, added_at, added_by, estimated_delivery_date
                  FROM purchase_orders WHERE status IN ('pending','partial') ORDER BY added_at ASC`)
    ]);

    // Build PO map: productId → [POs]
    const posMap = {};
    for (const po of posResult.rows) {
      if (!posMap[po.product_id]) posMap[po.product_id] = [];
      posMap[po.product_id].push({
        id: po.id,
        orderNumber: po.order_number,
        quantity: parseFloat(po.quantity),
        quantityReceived: parseFloat(po.quantity_received) || 0,
        supplier: po.supplier || '',
        status: po.status,
        notes: po.notes || '',
        addedAt: po.added_at,
        addedBy: po.added_by || '',
        estimatedDeliveryDate: po.estimated_delivery_date || null
      });
    }

    // Map to camelCase for frontend
    const products = result.rows.map(row => ({
      id: row.id,
      tag: row.tag,
      productCode: row.productCode,
      name: row.name,
      category: row.category,
      sub_category: row.sub_category || '',
      color: row.color || '',
      location: row.location || '',
      bin_location: row.bin_location || '',
      unit: row.unit,
      currentStock: parseFloat(row.currentStock) || 0,
      minStockLevel: parseFloat(row.minStockLevel) || 0,
      supplier: row.supplier || '',
      supplier_code: row.supplier_code || '',
      unitPerBox: parseInt(row.unitPerBox) || 1,
      stockBoxes: parseInt(row.stockBoxes) || 0,
      shopifySkus: parseJSONB(row.shopifySkus),
      skuMultipliers: parseJSONB(row.skuMultipliers),
      incomingOrders: posMap[row.id] || [],
      status: row.status || 'active',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const row = result.rows[0];
    res.json({
      id: row.id,
      tag: row.tag,
      productCode: row.productCode,
      name: row.name,
      category: row.category,
      sub_category: row.sub_category || '',
      color: row.color || '',
      location: row.location || '',
      bin_location: row.bin_location || '',
      unit: row.unit,
      currentStock: parseFloat(row.currentStock) || 0,
      minStockLevel: parseFloat(row.minStockLevel) || 0,
      supplier: row.supplier || '',
      supplier_code: row.supplier_code || '',
      unitPerBox: parseInt(row.unitPerBox) || 1,
      stockBoxes: parseInt(row.stockBoxes) || 0,
      shopifySkus: parseJSONB(row.shopifySkus),
      skuMultipliers: parseJSONB(row.skuMultipliers),
      incomingOrders: parseJSONB(row.incoming_orders, [])
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const {
      name, category, productCode, tag, unit, currentStock,
      minStockLevel, shopifySkus, skuMultipliers, supplier, supplier_code, unitPerBox,
      subCategory, sub_category, color, location, bin_location, userId
    } = req.body;
    
    // Map both camelCase and snake_case
    const finalSubCategory = sub_category || subCategory || null;
    const finalColor = color || null;
    const finalLocation = location || null;
    const finalBinLocation = bin_location || null;
    
    console.log('📥 Received:', { subCategory, sub_category, color, location, bin_location });
    console.log('✅ Using:', { finalSubCategory, finalColor, finalLocation, finalBinLocation });
    
    if (!name || !category) {
      return res.status(400).json({ error: 'Name and category are required' });
    }
    
    // Generate new ID (with proper numeric ordering)
    const maxIdResult = await pool.query(
      `SELECT id FROM products 
       WHERE id LIKE $1 
       ORDER BY CAST(SUBSTRING(id FROM '[0-9]+') AS INTEGER) DESC 
       LIMIT 1`,
      [`${category.toUpperCase()}_%`]
    );
    
    let maxNum = 0;
    if (maxIdResult.rows.length > 0) {
      const parts = maxIdResult.rows[0].id.split('_');
      maxNum = parseInt(parts[1]) || 0;
    }
    
    const newNum = maxNum + 1;
    let newId = `${category.toUpperCase()}_${newNum}`;
    
    // Safety check: ensure ID doesn't already exist
    const checkExisting = await pool.query('SELECT id FROM products WHERE id = $1', [newId]);
    if (checkExisting.rows.length > 0) {
      // ID exists, find the next available
      let safeNum = newNum + 1;
      let attempts = 0;
      while (attempts < 100) { // Max 100 attempts
        const testId = `${category.toUpperCase()}_${safeNum}`;
        const exists = await pool.query('SELECT id FROM products WHERE id = $1', [testId]);
        if (exists.rows.length === 0) {
          newId = testId;
          break;
        }
        safeNum++;
        attempts++;
      }
      console.log(`⚠️ ID ${category.toUpperCase()}_${newNum} exists, using ${newId} instead`);
    }
    
    const newTag = tag || `#${category.toUpperCase().substring(0, 2)}${String(newNum).padStart(5, '0')}`;
    const newProductCode = productCode || `${category.toUpperCase()}_${String(newNum).padStart(5, '0')}`;
    const stockBoxes = unitPerBox ? Math.floor((currentStock || 0) / unitPerBox) : 0;
    
    // ✅ Extract number from TAG for SKU generation
    let skuNumber = newNum; // Default: use ID number
    if (tag) {
      // If tag provided, extract number from it
      // Tag format: #SA00275 or #SA275 → extract 275
      const tagMatch = tag.match(/\d+/);
      if (tagMatch) {
        skuNumber = parseInt(tagMatch[0]);
      }
    }
    
    // ✅ Auto-generate SKUs using TAG number (for all categories)
    let finalShopifySkus = shopifySkus || {};
    if (!shopifySkus || Object.keys(shopifySkus).length === 0) {
      finalShopifySkus = generateAutoSkus(category, skuNumber);
      if (Object.keys(finalShopifySkus).length > 0) {
        console.log(`✨ Auto-generated SKUs for ${newId} (${category}) using number ${skuNumber} from tag ${tag || newTag}`);
      }
    }
    
    const skusJson = JSON.stringify(finalShopifySkus);
    const skuMultipliersJson = skuMultipliers && typeof skuMultipliers === 'object'
      ? JSON.stringify(skuMultipliers) : '{}';

    const result = await pool.query(
      `INSERT INTO products
       (id, tag, "productCode", name, category, unit, "currentStock", "minStockLevel",
        "shopifySkus", "skuMultipliers", supplier, "supplier_code", "unitPerBox", "stockBoxes", "incoming_orders",
        sub_category, color, location, bin_location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        newId, newTag, newProductCode, name, category, unit || 'units',
        currentStock || 0, minStockLevel || 0, skusJson, skuMultipliersJson,
        supplier || '', supplier_code || '', unitPerBox || 1, stockBoxes, '[]',
        finalSubCategory, finalColor, finalLocation, finalBinLocation
      ]
    );
    
    const row = result.rows[0];

    // Log product creation to audit_log
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'product_created', 'product', $2, $3, $4)`,
        [req.user.id, row.id, row.name, JSON.stringify({ category: row.category, productCode: row.productCode })]
      );
    } catch (auditErr) {
      console.warn('⚠️ audit_log insert failed:', auditErr.message);
    }

    // ========================================================================
    // OPTIONAL: Auto-create products in Shopify
    //Para funcionar essa parte voce precisa configurar o ENV no render || SHOPIFY informacoes:
    //API_KEY
    //API_PASSWORD
    //SHOPIFY_STORE_NAME
    //SHOPIFY_SYNC_ENABLED = precisa estar TRUE
    // ========================================================================
    if (['OILS', 'SCENT_MACHINES', 'MACHINES_SPARES', 'RAW_MATERIALS'].includes(category) && process.env.SHOPIFY_SYNC_ENABLED === 'true') {
      try {
        await createProductInShopify(row);
        console.log(`✅ Product synced to Shopify: ${row.name}`);
      } catch (shopifyError) {
        console.error('⚠️ Shopify sync failed:', shopifyError.message);
        // Continue anyway - product created locally
      }
    }
    
    res.json({
      id: row.id,
      tag: row.tag,
      productCode: row.productCode,
      name: row.name,
      category: row.category,
      sub_category: row.sub_category || '',
      color: row.color || '',
      location: row.location || '',
      bin_location: row.bin_location || '',
      unit: row.unit,
      currentStock: parseFloat(row.currentStock),
      minStockLevel: parseFloat(row.minStockLevel),
      supplier: row.supplier,
      supplier_code: row.supplier_code,
      unitPerBox: parseInt(row.unitPerBox),
      stockBoxes: parseInt(row.stockBoxes),
      shopifySkus: parseJSONB(row.shopifySkus),
      skuMultipliers: parseJSONB(row.skuMultipliers),
      incoming_orders: []
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const {
      name, category, productCode, tag, unit, currentStock,
      minStockLevel, shopifySkus, skuMultipliers, supplier, supplier_code, unitPerBox,
      subCategory, sub_category, color, location, bin_location
    } = req.body;
    
    // Map both camelCase and snake_case
    const finalSubCategory = sub_category || subCategory;
    const finalColor = color;
    const finalLocation = location;
    const finalBinLocation = bin_location;
    
    console.log('📥 PUT Received:', { subCategory, sub_category, color, location, bin_location });
    console.log('✅ PUT Using:', { finalSubCategory, finalColor, finalLocation, finalBinLocation });
    
    // currentStock is intentionally NOT updated here — stock only changes via
    // /api/stock/add, /api/stock/remove, /api/stock/adjust, webhook, or /api/returns.
    // Allowing the edit form to overwrite currentStock would silently reverse webhook deductions.

    let skusJson = null;
    if (shopifySkus !== undefined) {
      if (typeof shopifySkus !== 'object' || Array.isArray(shopifySkus)) {
        return res.status(400).json({ error: 'shopifySkus must be an object' });
      }
      // Key validation only applies to OILS — their keys map to Shopify variant configs.
      // For machines/spares/raw materials the webhook matches by VALUE, not key, so any key is valid.
      const VALID_SKU_KEYS = ['SA_CA', 'SA_HF', 'SA_CDIFF', 'SA_1L', 'SA_PRO', 'SA_DM', 'SA_MAC', 'SA_RM', 'SA_FORM'];
      for (const key of Object.keys(shopifySkus)) {
        if (category === 'OILS' && !VALID_SKU_KEYS.includes(key)) {
          return res.status(400).json({ error: `Invalid shopifySkus key: ${key}. Allowed: ${VALID_SKU_KEYS.join(', ')}` });
        }
        if (shopifySkus[key] !== null && shopifySkus[key] !== '' && typeof shopifySkus[key] !== 'string') {
          return res.status(400).json({ error: `shopifySkus.${key} must be a string or null` });
        }
      }
      skusJson = JSON.stringify(shopifySkus);
    }

    let skuMultipliersJson = null;
    if (skuMultipliers !== undefined) {
      if (typeof skuMultipliers !== 'object' || Array.isArray(skuMultipliers)) {
        return res.status(400).json({ error: 'skuMultipliers must be an object' });
      }
      skuMultipliersJson = JSON.stringify(skuMultipliers);
    }

    const result = await pool.query(
      `UPDATE products SET
       name = COALESCE($1, name),
       category = COALESCE($2, category),
       "productCode" = COALESCE($3, "productCode"),
       tag = COALESCE($4, tag),
       unit = COALESCE($5, unit),
       "minStockLevel" = COALESCE($6, "minStockLevel"),
       "shopifySkus" = COALESCE($7, "shopifySkus"),
       "skuMultipliers" = COALESCE($8, "skuMultipliers"),
       supplier = COALESCE($9, supplier),
       "supplier_code" = COALESCE($10, "supplier_code"),
       "unitPerBox" = COALESCE($11, "unitPerBox"),
       "stockBoxes" = FLOOR("currentStock" / NULLIF(COALESCE($11, "unitPerBox"), 0)),
       sub_category = CASE WHEN $12::text IS NOT NULL THEN $12 ELSE sub_category END,
       color = CASE WHEN $13::text IS NOT NULL THEN $13 ELSE color END,
       location = CASE WHEN $14::text IS NOT NULL THEN $14 ELSE location END,
       bin_location = CASE WHEN $15::text IS NOT NULL THEN $15 ELSE bin_location END
       WHERE id = $16
       RETURNING *`,
      [
        name, category, productCode, tag, unit, minStockLevel,
        skusJson, skuMultipliersJson, supplier, supplier_code, unitPerBox,
        finalSubCategory ?? null, finalColor ?? null, finalLocation ?? null, finalBinLocation ?? null, productId
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const row = result.rows[0];
    res.json({
      id: row.id,
      tag: row.tag,
      productCode: row.productCode,
      name: row.name,
      category: row.category,
      sub_category: row.sub_category || '',
      color: row.color || '',
      location: row.location || '',
      bin_location: row.bin_location || '',
      unit: row.unit,
      currentStock: parseFloat(row.currentStock),
      minStockLevel: parseFloat(row.minStockLevel),
      supplier: row.supplier,
      supplier_code: row.supplier_code,
      unitPerBox: parseInt(row.unitPerBox),
      stockBoxes: parseInt(row.stockBoxes),
      shopifySkus: parseJSONB(row.shopifySkus),
      skuMultipliers: parseJSONB(row.skuMultipliers)
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/products/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productId = req.params.id;
    const userId = req.query.userId || null;

    // Fetch product details before deletion for the audit log
    const productRes = await client.query(
      'SELECT id, name, "productCode", tag, category, unit FROM products WHERE id = $1',
      [productId]
    );
    if (productRes.rows.length === 0) {
      throw new Error('Product not found');
    }
    const product = productRes.rows[0];

    await client.query('DELETE FROM transactions WHERE product_id = $1', [productId]);

    // For SA_SCENTED_PRODUCTS the BOM variant equals the productCode of the SKU itself
    // (one BOM row set per finished-good SKU). Remove those rows so the BOM Viewer
    // doesn't show orphan variants after deletion.
    // (OILS BOMs use shared variants like SA_CA / SA_HF — never delete those.)
    if (product.category === 'SA_SCENTED_PRODUCTS' && product.productCode) {
      await client.query('DELETE FROM bom WHERE variant = $1', [product.productCode]);
    }

    await client.query('DELETE FROM products WHERE id = $1', [productId]);

    // Audit log — product deleted
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'product_deleted', 'product', $2, $3, $4)`,
      [req.user.id, productId, product.name, JSON.stringify({
        productCode: product.productCode || product.tag,
        category: product.category,
        unit: product.unit,
      })]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// STOCK OPERATIONS
// ========================================================================
router.post('/stock/add', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { productId, quantity, notes, shopifyOrderId } = req.body;
    
    if (!productId || !quantity || quantity <= 0) {
      throw new Error('Invalid input');
    }
    
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    
    if (productResult.rows.length === 0) {
      throw new Error('Product not found');
    }
    
    const product = productResult.rows[0];
    const newStock = parseFloat(product.currentStock) + parseFloat(quantity);
    
    await client.query(
      'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
      [newStock, Math.floor(newStock / product.unitPerBox), productId]
    );
    
    await client.query(
      `INSERT INTO transactions 
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [productId, product.productCode || product.tag, product.name, product.category, 'add', quantity, product.unit, newStock, notes || '', shopifyOrderId || null]
    );
    
    await client.query('COMMIT');
    
    res.json({ 
      success: true, 
      newStock,
      product: {
        ...product,
        currentStock: newStock
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/stock/remove', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { productId, quantity, notes, shopifyOrderId } = req.body;
    
    if (!productId || !quantity || quantity <= 0) {
      throw new Error('Invalid input');
    }
    
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    
    if (productResult.rows.length === 0) {
      throw new Error('Product not found');
    }
    
    const product = productResult.rows[0];
    const newStock = parseFloat(product.currentStock) - parseFloat(quantity);
    
    // Allow negative stock to track discrepancies
    
    await client.query(
      'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
      [newStock, Math.floor(newStock / product.unitPerBox), productId]
    );
    
    await client.query(
      `INSERT INTO transactions 
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [productId, product.productCode || product.tag, product.name, product.category, 'remove', quantity, product.unit, newStock, notes || '', shopifyOrderId || null]
    );
    
    await client.query('COMMIT');
    
    res.json({ 
      success: true, 
      newStock,
      product: {
        ...product,
        currentStock: newStock
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// STOCK ADJUST - Manual stock adjustments (add or remove)
// ========================================================================
router.post('/stock/adjust', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { productId, quantity, type, note, userId } = req.body;
    
    if (!productId || !quantity || !type) {
      throw new Error('Missing required fields: productId, quantity, type');
    }
    
    if (!['add', 'remove'].includes(type)) {
      throw new Error('Type must be either "add" or "remove"');
    }
    
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (productResult.rows.length === 0) {
      throw new Error('Product not found');
    }

    const product = productResult.rows[0];
    const currentStock = parseFloat(product.currentStock) || 0;
    const adjustQuantity = parseFloat(quantity);
    
    let newStock;
    if (type === 'add') {
      newStock = currentStock + adjustQuantity;
    } else {
      newStock = currentStock - adjustQuantity;
      // Allow negative stock to track discrepancies
    }
    
    // Update product stock
    await client.query(
      'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
      [newStock, Math.floor(newStock / (product.unitPerBox || 1)), productId]
    );
    
    // Create transaction record
    await client.query(
      `INSERT INTO transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        productId,
        product.productCode || product.tag,
        product.name,
        product.category,
        type,
        adjustQuantity,
        product.unit || 'units',
        newStock,
        note || `Manual ${type} adjustment`,
        userId || null
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      newStock,
      product: {
        ...product,
        currentStock: newStock,
        stockBoxes: Math.floor(newStock / (product.unitPerBox || 1))
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// TRANSACTIONS
// ========================================================================
router.get('/transactions', async (req, res) => {
  try {
    const { limit = 5000, offset = 0, productId, type, category, dateFrom, dateTo } = req.query;

    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (productId) {
      params.push(productId);
      query += ` AND product_id = $${params.length}`;
    }

    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }

    if (category && category !== 'ALL') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }

    if (dateFrom) {
      params.push(dateFrom);
      query += ` AND (created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`;
    }

    if (dateTo) {
      params.push(dateTo);
      query += ` AND (created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`;
    }

    query += ' ORDER BY created_at DESC, id DESC';

    params.push(Math.min(parseInt(limit) || 5000, 5000));
    query += ` LIMIT $${params.length}`;

    params.push(Math.max(parseInt(offset) || 0, 0));
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// AUDIT LOG
// ========================================================================
router.get('/audit', async (req, res) => {
  try {
    const { limit = 500, offset = 0, userId, type, category, dateFrom, dateTo, hideSystem = 'true' } = req.query;
    const results = [];

    // Types that live in audit_log (not transactions table)
    const AUDIT_LOG_TYPES = ['product_created', 'product_deleted', 'sku_published', 'sku_added', 'po_created', 'po_cancelled', 'po_received', 'formula_created', 'formula_updated', 'formula_deleted', 'formula_ready_received', 'formula_ready_adjusted', 'product_deactivated', 'product_activated', 'scented_group_created', 'scented_group_deleted', 'tech_transfer', 'tech_remove', 'tech_return'];
    const isAuditLogType = AUDIT_LOG_TYPES.includes(type);

    // ── Stock transactions ─────────────────────────────────────────────────
    if (!isAuditLogType) {
      let txQuery = `
        SELECT t.id::text AS id, t.created_at, t.user_id,
               COALESCE(u.name, 'System') AS performed_by,
               t.type AS action, t.product_name AS entity_name,
               t.product_code AS entity_code, t.category,
               t.quantity, t.unit, t.balance_after, t.notes,
               'stock' AS source
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE 1=1
      `;
      const tp = [];
      if (hideSystem === 'true') txQuery += ' AND t.user_id IS NOT NULL';
      if (userId)                { tp.push(parseInt(userId)); txQuery += ` AND t.user_id = $${tp.length}`; }
      if (type)                  { tp.push(type);             txQuery += ` AND t.type = $${tp.length}`; }
      if (category && category !== 'ALL') { tp.push(category); txQuery += ` AND t.category = $${tp.length}`; }
      if (dateFrom)              { tp.push(dateFrom);         txQuery += ` AND (t.created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date >= $${tp.length}::date`; }
      if (dateTo)                { tp.push(dateTo);           txQuery += ` AND (t.created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date <= $${tp.length}::date`; }
      const txResult = await pool.query(txQuery, tp);
      results.push(...txResult.rows);
    }

    // ── Product + PO events (audit_log) ───────────────────────────────────
    if (!type || isAuditLogType) {
      let alQuery = `
        SELECT al.id::text AS id, al.created_at, al.user_id,
               COALESCE(u.name, 'Unknown') AS performed_by,
               al.action, al.entity_name,
               COALESCE(al.details->>'product_code', al.entity_id::text) AS entity_code,
               al.details->>'category' AS category,
               NULL::numeric AS quantity, NULL AS unit,
               NULL::numeric AS balance_after,
               al.details::text AS notes,
               'product' AS source
        FROM audit_log al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE 1=1
      `;
      const ap = [];
      if (userId)   { ap.push(parseInt(userId)); alQuery += ` AND al.user_id = $${ap.length}`; }
      if (type)     { ap.push(type);             alQuery += ` AND al.action = $${ap.length}`; }
      if (category && category !== 'ALL') { ap.push(category); alQuery += ` AND al.details->>'category' = $${ap.length}`; }
      if (dateFrom) { ap.push(dateFrom);         alQuery += ` AND (al.created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date >= $${ap.length}::date`; }
      if (dateTo)   { ap.push(dateTo);           alQuery += ` AND (al.created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date <= $${ap.length}::date`; }
      const alResult = await pool.query(alQuery, ap);
      results.push(...alResult.rows);
    }

    results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const safeLimit = Math.min(parseInt(limit) || 500, 2000);
    const safeOffset = Math.max(parseInt(offset) || 0, 0);
    res.json(results.slice(safeOffset, safeOffset + safeLimit));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/audit/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM users ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// DASHBOARD
// ========================================================================
router.get('/dashboard', async (req, res) => {
  try {
    const [productsResult, transactionsResult, lowStockResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM products'),
      pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10'),
      pool.query(`
        SELECT COUNT(*) as count 
        FROM products 
        WHERE "currentStock" < "minStockLevel"
      `)
    ]);
    
    const oilsVolume = await pool.query(`
      SELECT COALESCE(SUM("currentStock"), 0) as total 
      FROM products 
      WHERE category = 'OILS'
    `);
    
    res.json({
      totalProducts: parseInt(productsResult.rows[0].count),
      lowStockCount: parseInt(lowStockResult.rows[0].count),
      totalStockValue: {
        oils: Math.round(parseFloat(oilsVolume.rows[0].total) * 100) / 100
      },
      recentTransactions: transactionsResult.rows
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// BOM
// ========================================================================
router.get('/bom', async (req, res) => {
  try {
    const { variant } = req.query;
    
    let query = 'SELECT * FROM bom';
    const params = [];
    
    if (variant) {
      params.push(variant);
      query += ' WHERE variant = $1';
    }
    
    query += ' ORDER BY variant, seq';
    
    const result = await pool.query(query, params);
    
    // Group by variant
    const bomGrouped = {};
    result.rows.forEach(row => {
      if (!bomGrouped[row.variant]) {
        bomGrouped[row.variant] = [];
      }
      bomGrouped[row.variant].push({
        seq: row.seq,
        componentCode: row.component_code,
        componentName: row.component_name,
        quantity: parseFloat(row.quantity)
      });
    });
    
    res.json(bomGrouped);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/bom', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
    const { variant, componentCode, componentName, quantity } = req.body;
    
    const existing = await pool.query(
      'SELECT * FROM bom WHERE variant = $1 AND component_code = $2',
      [variant, componentCode]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Component already exists in this BOM' });
    }
    
    const seqResult = await pool.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM bom WHERE variant = $1',
      [variant]
    );
    
    await pool.query(
      `INSERT INTO bom (variant, seq, component_code, component_name, quantity) 
       VALUES ($1, $2, $3, $4, $5)`,
      [variant, seqResult.rows[0].next_seq, componentCode, componentName, quantity]
    );
    
    const result = await pool.query(
      'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
      [variant]
    );
    
    const components = result.rows.map(row => ({
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: components });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/bom/:variant/component/:componentCode', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
    const { variant, componentCode } = req.params;
    const { componentName, quantity } = req.body;
    
    const result = await pool.query(
      `UPDATE bom SET 
       component_name = COALESCE($1, component_name),
       quantity = COALESCE($2, quantity)
       WHERE variant = $3 AND component_code = $4
       RETURNING *`,
      [componentName, quantity, variant, componentCode]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Component not found' });
    }
    
    const allComponents = await pool.query(
      'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
      [variant]
    );
    
    const components = allComponents.rows.map(row => ({
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: components });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/bom/:variant/component/:componentCode', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { variant, componentCode } = req.params;
    
    const deleteResult = await client.query(
      'DELETE FROM bom WHERE variant = $1 AND component_code = $2 RETURNING id',
      [variant, componentCode]
    );
    
    if (deleteResult.rows.length === 0) {
      throw new Error('Component not found');
    }
    
    const components = await client.query(
      'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
      [variant]
    );
    
    for (let i = 0; i < components.rows.length; i++) {
      await client.query(
        'UPDATE bom SET seq = $1 WHERE id = $2',
        [i + 1, components.rows[i].id]
      );
    }
    
    await client.query('COMMIT');
    
    const result = await pool.query(
      'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
      [variant]
    );
    
    const updatedComponents = result.rows.map(row => ({
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: updatedComponents });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// DIFFUSER MACHINE BOM
// ========================================================================

router.get('/diffuser-bom', async (req, res) => {
  try {
    const { machineType } = req.query;
    
    let query = 'SELECT * FROM diffuser_bom';
    const params = [];
    
    if (machineType) {
      params.push(machineType);
      query += ' WHERE machine_type = $1';
    }
    
    query += ' ORDER BY machine_type, seq';
    
    const result = await pool.query(query, params);
    
    // Group by machine type
    const bomGrouped = {};
    result.rows.forEach(row => {
      if (!bomGrouped[row.machine_type]) {
        bomGrouped[row.machine_type] = [];
      }
      bomGrouped[row.machine_type].push({
        id: row.id,
        seq: row.seq,
        componentCode: row.component_code,
        componentName: row.component_name,
        quantity: parseFloat(row.quantity)
      });
    });
    
    res.json(bomGrouped);
  } catch (error) {
    console.error('Get diffuser BOM error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/diffuser-bom', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
    const { machineType, componentCode, componentName, quantity } = req.body;
    
    // Check if component already exists
    const existing = await pool.query(
      'SELECT * FROM diffuser_bom WHERE machine_type = $1 AND component_code = $2',
      [machineType, componentCode]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Component already exists in this BOM' });
    }
    
    // Get next sequence number
    const seqResult = await pool.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM diffuser_bom WHERE machine_type = $1',
      [machineType]
    );
    
    // Insert component
    await pool.query(
      `INSERT INTO diffuser_bom (machine_type, seq, component_code, component_name, quantity) 
       VALUES ($1, $2, $3, $4, $5)`,
      [machineType, seqResult.rows[0].next_seq, componentCode, componentName, quantity || 1]
    );
    
    // Return updated BOM
    const result = await pool.query(
      'SELECT * FROM diffuser_bom WHERE machine_type = $1 ORDER BY seq',
      [machineType]
    );
    
    const components = result.rows.map(row => ({
      id: row.id,
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: components });
  } catch (error) {
    console.error('Add diffuser BOM component error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/diffuser-bom/:id', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
    const { id } = req.params;
    const { componentName, quantity } = req.body;
    
    // Update component
    const updateResult = await pool.query(
      `UPDATE diffuser_bom SET 
       component_name = COALESCE($1, component_name),
       quantity = COALESCE($2, quantity),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING machine_type`,
      [componentName, quantity, id]
    );
    
    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Component not found' });
    }
    
    const machineType = updateResult.rows[0].machine_type;
    
    // Return updated BOM
    const result = await pool.query(
      'SELECT * FROM diffuser_bom WHERE machine_type = $1 ORDER BY seq',
      [machineType]
    );
    
    const components = result.rows.map(row => ({
      id: row.id,
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: components });
  } catch (error) {
    console.error('Update diffuser BOM component error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/diffuser-bom/:id', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Delete component and get machine type
    const deleteResult = await client.query(
      'DELETE FROM diffuser_bom WHERE id = $1 RETURNING machine_type',
      [id]
    );
    
    if (deleteResult.rows.length === 0) {
      throw new Error('Component not found');
    }
    
    const machineType = deleteResult.rows[0].machine_type;
    
    // Resequence remaining components
    const components = await client.query(
      'SELECT * FROM diffuser_bom WHERE machine_type = $1 ORDER BY seq',
      [machineType]
    );
    
    for (let i = 0; i < components.rows.length; i++) {
      await client.query(
        'UPDATE diffuser_bom SET seq = $1 WHERE id = $2',
        [i + 1, components.rows[i].id]
      );
    }
    
    await client.query('COMMIT');
    
    // Return updated BOM
    const result = await pool.query(
      'SELECT * FROM diffuser_bom WHERE machine_type = $1 ORDER BY seq',
      [machineType]
    );
    
    const updatedComponents = result.rows.map(row => ({
      id: row.id,
      seq: row.seq,
      componentCode: row.component_code,
      componentName: row.component_name,
      quantity: parseFloat(row.quantity)
    }));
    
    res.json({ success: true, bom: updatedComponents });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete diffuser BOM component error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// ATTACHMENTS 
// Secao desabilitada pois esta com problema quando eu faco o upload do arquivo o mesmo esta crashando o banco de dados, nao irei arrumar esta secao ainda1
//Possivel causa banco de dados+code (Fabricio Leopoldino 23/02/26
// ========================================================================
router.get('/attachments', async (req, res) => {
  try {
    const { oilId, fileType } = req.query;
    
    let query = 'SELECT * FROM attachments WHERE 1=1';
    const params = [];
    
    if (oilId) {
      params.push(oilId);
      query += ` AND associated_oil_id = $${params.length}`;
    }
    
    if (fileType) {
      params.push(`%${fileType}%`);
      query += ` AND file_type ILIKE $${params.length}`;
    }
    
    query += ' ORDER BY upload_date DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/attachments/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { associatedOilId, associatedOilName, uploadedBy, notes } = req.body;
    
    const result = await pool.query(
      `INSERT INTO attachments 
       (file_name, stored_file_name, file_type, file_size, file_path, 
        associated_oil_id, associated_oil_name, uploaded_by, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING *`,
      [
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        `/uploads/${req.file.filename}`,
        associatedOilId || 'GENERAL',
        associatedOilName || 'General Documents',
        uploadedBy || 'admin',
        notes || ''
      ]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/attachments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM attachments WHERE id = $1 RETURNING stored_file_name',
      [parseInt(req.params.id)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    
    const filePath = join(__dirname, '../uploads', result.rows[0].stored_file_name);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// EXPORTS
// ========================================================================
router.get('/export/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY tag');
    const products = result.rows.map(row => ({
      id: row.id,
      tag: row.tag,
      productCode: row.productCode,
      name: row.name,
      category: row.category,
      currentStock: parseFloat(row.currentStock),
      minStockLevel: parseFloat(row.minStockLevel),
      supplier: row.supplier,
      shopifySkus: parseJSONB(row.shopifySkus)
    }));
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/export/transactions', async (req, res) => {
  try {
    const safeLimit = Math.min(parseInt(req.query.limit) || 5000, 10000);
    const result = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1', [safeLimit]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// HELPER: Get volume from SKU type
// ========================================================================
const getVolumeFromSKU = (sku) => {
  const skuUpper = sku.toUpperCase();
  
  // Volume mapping
  if (skuUpper.includes('SA_CA')) return 400;      // Cartridge = 400ml
  if (skuUpper.includes('SA_1L')) return 1000;     // 1 Liter = 1000ml
  if (skuUpper.includes('SA_HF')) return 500;      // Half = 500ml
  if (skuUpper.includes('SA_PRO')) return 1000;    // Pro = 1000ml
  if (skuUpper.includes('SA_CDIFF')) return 700;   // Bottle Diffuser = 700ml
  
  return 1; // Default fallback
};

// ========================================================================
// HELPER: Get variant from SKU
// ========================================================================
const getVariantFromSKU = (sku) => {
  const skuUpper = sku.toUpperCase();
  
  if (skuUpper.includes('SA_CA')) return 'SA_CA';
  if (skuUpper.includes('SA_1L')) return 'SA_1L';
  if (skuUpper.includes('SA_HF')) return 'SA_HF';
  if (skuUpper.includes('SA_PRO')) return 'SA_PRO';
  if (skuUpper.includes('SA_CDIFF')) return 'SA_CDIFF';
  
  return null;
};

// ========================================================================
// SHOPIFY PRODUCT STATUS - fetch all products and map SKU → status
// ========================================================================
router.get('/shopify/status', async (req, res) => {
  try {
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
    if (!process.env.SHOPIFY_STORE_NAME || !accessToken) {
      return res.json({ enabled: false, statuses: {} });
    }

    let allProducts = [];
    let url = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-01/products.json?limit=250&fields=id,title,status,variants`;

    while (url) {
      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });
      if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
      const data = await response.json();
      allProducts = allProducts.concat(data.products || []);
      const linkHeader = response.headers.get('link');
      const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    // Build SKU → { status, shopifyId, title, variantId } map
    const statuses = {};
    allProducts.forEach(product => {
      (product.variants || []).forEach(variant => {
        if (variant.sku) {
          statuses[variant.sku] = {
            status: product.status,        // 'active' | 'draft' | 'archived'
            shopifyId: product.id,
            title: product.title,
            variantId: variant.id
          };
        }
      });
    });

    res.json({ enabled: true, statuses });
  } catch (err) {
    console.error('Shopify status fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// SHOPIFY PENDING ORDERS - fetch unfulfilled customer orders for demand view
// ========================================================================
router.get('/shopify/pending-orders', async (req, res) => {
  try {
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
    if (!process.env.SHOPIFY_STORE_NAME || !accessToken) {
      return res.json({ enabled: false, orders: [] });
    }

    // Strip .myshopify.com if the env var already includes it
    const storeName = process.env.SHOPIFY_STORE_NAME.replace(/\.myshopify\.com$/i, '');
    const url = `https://${storeName}.myshopify.com/admin/api/2025-01/orders.json?status=open&fulfillment_status=unfulfilled&limit=50&fields=id,order_number,created_at,customer,line_items,total_price`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
    const data = await response.json();

    // For each line item, try to find the local product by SKU
    const allProducts = (await pool.query('SELECT id, name, "productCode", unit, "shopifySkus" FROM products')).rows;

    const findLocalProduct = (sku) => {
      for (const p of allProducts) {
        const skus = typeof p.shopifySkus === 'object' ? p.shopifySkus : {};
        const skuValues = Object.values(skus);
        if (skuValues.includes(sku)) return { id: p.id, name: p.name, productCode: p.productCode, unit: p.unit };
      }
      return null;
    };

    const orders = (data.orders || []).map(order => ({
      shopifyOrderId: order.id,
      orderNumber: order.order_number,
      createdAt: order.created_at,
      customer: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'N/A',
      totalPrice: order.total_price,
      lineItems: (order.line_items || []).map(item => ({
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
        localProduct: findLocalProduct(item.sku)
      }))
    }));

    res.json({ enabled: true, orders });
  } catch (err) {
    const cause = err.cause?.message || err.cause?.code || '';
    console.error('Shopify pending orders error:', err.message, cause ? `(${cause})` : '');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// SHOPIFY PUBLISH - create a local product in Shopify (draft)
// ========================================================================
router.post('/shopify/publish/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { userId } = req.body || {};
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = { ...result.rows[0], shopifySkus: parseJSONB(result.rows[0].shopifySkus) };
    const { added, failed } = await createProductInShopify(product);
    // Log to audit_log
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'sku_published', 'product', $2, $3, $4)`,
        [req.user.id, product.id, product.name, JSON.stringify({ added: added.length, failed: failed.length, skus: added.map(a => a.sku) })]
      );
    } catch (auditErr) { console.warn('audit_log failed:', auditErr.message); }
    res.json({ success: true, added: added.length, failed: failed.length, addedProducts: added, failedProducts: failed });
  } catch (err) {
    console.error('Shopify publish error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// SHOPIFY ADD MISSING PRODUCTS - create separate Shopify products for missing SKUs
// Each SKU type is published as its own product (matching Scent Australia's Shopify structure)
// ========================================================================
const VARIANT_DETAILS = {
  'SA_CA':    { suffix: 'Oil Cartridge (400ml)',       price: '165.00',  weight: 400,  weight_unit: 'g' },
  'SA_HF':    { suffix: '-500ML Oil Refill Bottle',    price: '150.00',  weight: 500,  weight_unit: 'g' },
  'SA_CDIFF': { suffix: 'Oil Refill (700ml)',           price: '275.00',  weight: 700,  weight_unit: 'g' },
  'SA_1L':    { suffix: '1L Oil Refill Bottle',        price: '218.90',  weight: 1000, weight_unit: 'g' },
  'SA_PRO':   { suffix: '-1L Oil Refill Pro Bottle',   price: '275.00',  weight: 1000, weight_unit: 'g' },
};

router.post('/shopify/add-missing-variants/:productId', async (req, res) => {
  try {
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
    if (!process.env.SHOPIFY_STORE_NAME || !accessToken) {
      return res.status(400).json({ error: 'Shopify credentials not configured.' });
    }

    // 1. Get product from DB
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.productId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = { ...result.rows[0], shopifySkus: parseJSONB(result.rows[0].shopifySkus) };

    if (!product.shopifySkus || typeof product.shopifySkus !== 'object') {
      return res.status(400).json({ error: 'Product has no Shopify SKUs configured' });
    }

    // 2. Fetch ALL live Shopify products (paginated) to find which SKUs already exist
    const existingSkus = new Set();
    let pageUrl = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-01/products.json?limit=250&fields=id,title,status,variants`;
    while (pageUrl) {
      const pageRes = await fetch(pageUrl, { headers: { 'X-Shopify-Access-Token': accessToken } });
      if (!pageRes.ok) throw new Error(`Shopify API error: ${pageRes.status}`);
      const pageData = await pageRes.json();
      (pageData.products || []).forEach(p => {
        (p.variants || []).forEach(v => { if (v.sku) existingSkus.add(v.sku); });
      });
      const linkHeader = pageRes.headers.get('link');
      const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }

    // 3. Find which SKUs are missing
    const allSkus = Object.entries(product.shopifySkus); // [[type, sku], ...]
    const missingSkus = allSkus.filter(([, sku]) => sku && !existingSkus.has(sku));

    if (missingSkus.length === 0) {
      return res.json({ success: true, message: 'All products already exist in Shopify', added: 0 });
    }

    // 4. Create a NEW separate Shopify product for each missing SKU
    // (Scent Australia structure: one product per size, not variants of one product)
    const added = [];
    const failed = [];
    const shopifyApiUrl = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-01/products.json`;

    for (const [type, sku] of missingSkus) {
      const details = VARIANT_DETAILS[type];
      if (!details) continue;

      const productTitle = `${product.name} ${details.suffix}`;
      const newShopifyProduct = {
        product: {
          title: productTitle,
          body_html: `<p>${productTitle}</p><p>Product Code: ${product.productCode || ''}</p>`,
          vendor: product.supplier || 'Scent Australia',
          product_type: 'Fragrance Oil',
          status: 'draft',
          variants: [{
            sku,
            price: details.price,
            weight: details.weight,
            weight_unit: details.weight_unit,
            inventory_management: null,
            inventory_policy: 'continue'
          }]
        }
      };

      const createRes = await fetch(shopifyApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify(newShopifyProduct)
      });

      if (createRes.ok) {
        const created = await createRes.json();
        added.push({ type, sku, title: productTitle, shopifyId: created.product.id });
        console.log(`✅ Created new Shopify product "${productTitle}" (SKU: ${sku})`);
      } else {
        const errText = await createRes.text();
        failed.push({ type, sku, error: errText });
        console.error(`❌ Failed to create product for SKU ${sku}:`, errText);
      }
    }

    // Log to audit_log
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'sku_added', 'product', $2, $3, $4)`,
        [req.user.id, product.id, product.name, JSON.stringify({ added: added.length, failed: failed.length, skus: added.map(a => a.sku) })]
      );
    } catch (auditErr) { console.warn('audit_log failed:', auditErr.message); }
    res.json({
      success: true,
      added: added.length,
      addedProducts: added,
      failed: failed.length,
      failedProducts: failed
    });
  } catch (err) {
    console.error('Add missing variants error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// SHOPIFY WEBHOOK - SMART ORDER HANDLER WITH BOM INTEGRATION
// ========================================================================
// Appendix A step 7: exported handler — the platform webhook receiver
// (/api/webhook/shopify/:store) verifies HMAC context and dispatches
// fulfillments/* topics here. Body must arrive parsed with req.rawBody set.
export async function saWebhookHandler(req, res) {
  const client = await pool.connect();
  // Declare outside try so catch block can access for lock cleanup
  let orderNumber = null;
  let clientReleased = false; // Guard against double-release in finally
  
  try {
    // ── HMAC signature verification ─────────────────────────────────────────
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const shopifyHmac = req.headers['x-shopify-hmac-sha256'];
      if (!shopifyHmac || !req.rawBody) {
        clientReleased = true; client.release();
        return res.status(401).json({ error: 'Missing webhook signature' });
      }
      const digest = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('base64');
      const trusted = Buffer.from(digest);
      const received = Buffer.from(shopifyHmac);
      const signaturesMatch = trusted.length === received.length &&
        crypto.timingSafeEqual(trusted, received);
      if (!signaturesMatch) {
        console.warn('⛔ Webhook rejected — invalid HMAC signature');
        clientReleased = true; client.release();
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      console.log('✅ Webhook HMAC verified');
    } else if (process.env.NODE_ENV === 'production') {
      clientReleased = true; client.release();
      console.error('❌ SHOPIFY_WEBHOOK_SECRET not set in production — rejecting webhook');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    } else {
      console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC verification (dev only)');
    }

    console.log('📬 Shopify webhook received');
    const webhookTopic = req.headers['x-shopify-topic'];
    // Shopify sends a unique delivery ID per webhook attempt
    const webhookDeliveryId = req.headers['x-shopify-webhook-id'] || req.headers['x-shopify-delivery-id'] || null;
    console.log('📦 Webhook type:', webhookTopic || 'unknown');
    console.log('🔑 Webhook delivery ID:', webhookDeliveryId || 'none');

    // orders/fulfilled fires simultaneously with the final fulfillments/create for the same order.
    // Both would debit the same stock → double-debit. fulfillments/create handles ALL fulfillments
    // (partial and final) so orders/fulfilled is redundant and must be skipped entirely.
    if (webhookTopic === 'orders/fulfilled') {
      console.log('ℹ️ orders/fulfilled — stock handled by fulfillments/create, skipping');
      return res.status(200).json({ received: true, skipped: 'handled_by_fulfillments_create' });
    }

    const { line_items, name: orderNumber_body, id: orderId } = req.body;
    // Strip partial-fulfillment suffix so "#34136.1" and "#34136" are treated as the same order
    const baseOrderName = orderNumber_body ? orderNumber_body.split('.')[0] : orderNumber_body;
    // Each fulfillment gets its own idempotency key so multiple partial fulfillments are
    // each processed once; orders/fulfilled uses the base name (blocked by Layer 3 if any
    // partial already wrote transactions with shopify_order_id = baseOrderName)
    const idempotencyKey = (webhookTopic === 'fulfillments/create' && orderId)
      ? `fulfillment_${orderId}`
      : baseOrderName;
    orderNumber = idempotencyKey; // assign to outer variable for lock cleanup in finally
    
    if (!line_items || !Array.isArray(line_items)) {
      console.warn('⚠️ Webhook received without line_items — acknowledging and skipping');
      return res.status(200).json({ received: true, skipped: 'no_line_items' });
    }
    
    // ========================================================================
    // OPTION 1: ORDER FULFILLMENT - Auto debit stock + BOM components
    // ========================================================================
    if (webhookTopic === 'fulfillments/create') {
      console.log('🚚 Order Fulfillment - Auto debiting stock + BOM...');

      // ════════════════════════════════════════════════════════════════════
      // 🔒 3-LAYER IDEMPOTENCY GUARD — prevents any order from being
      //    processed more than once, regardless of order size or timing.
      //
      // LAYER 1 — In-memory lock (catches simultaneous requests on same server)
      // LAYER 2 — DB unique lock via INSERT (catches restarts / race conditions)  
      // LAYER 3 — Transaction check (final fallback, catches everything else)
      // ════════════════════════════════════════════════════════════════════

      // ── LAYER 1: In-memory lock ───────────────────────────────────────────
      // Two webhook requests arriving within milliseconds of each other will
      // both pass the DB check before either writes — the in-memory Set catches
      // this race condition instantly.
      if (processingOrders.has(orderNumber)) {
        console.log(`⚠️  [LAYER 1] Order ${orderNumber} is currently being processed — ignoring duplicate.`);
        clientReleased = true; client.release();
        return res.status(200).json({ success: true, message: 'Order already being processed', order: orderNumber });
      }
      processingOrders.add(orderNumber);

      // ── LAYER 2: DB unique lock ───────────────────────────────────────────
      // Uses INSERT ... ON CONFLICT DO NOTHING with a UNIQUE constraint on
      // (shopify_order_id, type) in the webhook_processed table.
      // Even across server restarts or multiple instances, only one INSERT wins.
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS webhook_processed (
            order_id TEXT NOT NULL,
            webhook_type TEXT NOT NULL,
            processed_at TIMESTAMPTZ DEFAULT NOW(),
            CONSTRAINT webhook_processed_unique UNIQUE (order_id, webhook_type)
          )
        `);
        // orders/fulfilled uses 'order_fulfilled' so it collides with the sentinel
        // written by any prior fulfillments/create for the same base order number
        const webhookLockType = webhookTopic === 'orders/fulfilled' ? 'order_fulfilled' : 'fulfillment';
        const lockResult = await pool.query(`
          INSERT INTO webhook_processed (order_id, webhook_type)
          VALUES ($1, $2)
          ON CONFLICT (order_id, webhook_type) DO NOTHING
          RETURNING order_id
        `, [orderNumber, webhookLockType]);
        if (lockResult.rowCount === 0) {
          console.log(`⚠️  [LAYER 2] Order ${orderNumber} already locked in DB — ignoring duplicate.`);
          processingOrders.delete(orderNumber);
          clientReleased = true; client.release();
          return res.status(200).json({ success: true, message: 'Order already processed', order: orderNumber });
        }
        console.log(`✅ [LAYER 2] Lock acquired for order ${orderNumber}`);

        // For fulfillments/create: write a sentinel keyed by base order name so that
        // orders/fulfilled is blocked via Layer 2 even after multiple partial fulfillments.
        // This does NOT block subsequent partials because their idempotencyKey is the
        // fulfillment numeric ID — only orders/fulfilled uses the base order name as key.
        if (webhookTopic === 'fulfillments/create') {
          await pool.query(`
            INSERT INTO webhook_processed (order_id, webhook_type)
            VALUES ($1, 'order_fulfilled')
            ON CONFLICT (order_id, webhook_type) DO NOTHING
          `, [baseOrderName]);
          console.log(`📌 [LAYER 2] Sentinel written for base order ${baseOrderName} — orders/fulfilled will be blocked`);
        }
      } catch (lockErr) {
        console.error('⚠️  Webhook lock error (non-fatal):', lockErr.message);
        // Continue — Layer 3 will catch it if needed
      }

      // ── LAYER 3: Transaction check (final fallback, orders/fulfilled only) ───
      // fulfillments/create is already uniquely guarded by fulfillment numeric ID in
      // Layer 2 — applying Layer 3 here would block the 2nd partial fulfillment.
      if (webhookTopic === 'orders/fulfilled') {
        const dupOrder = await pool.query(
          `SELECT 1 FROM transactions WHERE shopify_order_id = $1 AND type = 'shopify_sale' LIMIT 1`,
          [baseOrderName]
        );
        if (dupOrder.rows.length > 0) {
          console.log(`⚠️  [LAYER 3] Order ${baseOrderName} found in transactions — ignoring duplicate.`);
          processingOrders.delete(orderNumber);
          clientReleased = true; client.release();
          return res.status(200).json({ success: true, message: 'Order already processed', order: baseOrderName });
        }
      }

      // ── All guards passed — safe to process ──────────────────────────────
      console.log(`✅ All 3 guards passed — processing order ${orderNumber}`);

      // Write to queue BEFORE sending 200 — if server crashes after 200 but before
      // COMMIT, startup job detects this item as 'pending' and flags it for review.
      await pool.query(`
        INSERT INTO webhook_queue (idempotency_key, topic, payload, status)
        VALUES ($1, $2, $3, 'processing')
        ON CONFLICT (idempotency_key) DO UPDATE SET status = 'processing'
      `, [orderNumber, webhookTopic, JSON.stringify(req.body)]);

      // Acknowledge Shopify IMMEDIATELY so it stops retrying.
      // Large orders take time — responding first prevents the retry loop.
      res.status(200).json({ success: true, message: 'Webhook acknowledged, processing...', order: orderNumber });

      await client.query('BEGIN');
      
      for (const item of line_items) {
        const { sku, quantity } = item;
        
        if (!sku || !quantity) continue;
        
        // ── Formula / Blend SKU check (SA_FORM_XXXXX_400 / _1L) ─────────────
        if (sku.startsWith('SA_FORM_')) {
          const sizeMatch = sku.match(/_(\d+)$|_(1L)$/i);
          const sizeMl = sizeMatch
            ? (sizeMatch[1] === '1L' || sizeMatch[2] === '1L' ? 1000 : parseInt(sizeMatch[1]))
            : null;

          const formulaResult = await client.query(
            `SELECT * FROM formulas WHERE shopify_skus::text ILIKE $1 LIMIT 1 FOR UPDATE`,
            [`%${sku}%`]
          );

          if (formulaResult.rows.length > 0 && sizeMl) {
            const formula = formulaResult.rows[0];
            const totalMl = sizeMl * parseFloat(quantity);
            const readyMl = parseFloat(formula.ready_stock_ml) || 0;

            console.log(`🧪 Formula SKU: ${sku} → ${formula.name} | ${quantity}x${sizeMl}ml = ${totalMl}ml | Ready: ${readyMl}ml`);

            if (readyMl >= totalMl) {
              // ✅ Fully covered by ready stock — skip raw deduction
              const newReady = readyMl - totalMl;
              await client.query(`UPDATE formulas SET ready_stock_ml = $1 WHERE id = $2`, [newReady, formula.id]);
              await pool.query(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
                 VALUES (NULL, 'formula_ready_used', 'formula', $1, $2, $3)`,
                [formula.id, formula.name,
                 JSON.stringify({ product_code: formula.product_code, mlUsed: totalMl, remainingMl: newReady, orderId: baseOrderName, sku })]
              );
              console.log(`  ✅ Ready stock used: -${totalMl}mL (remaining: ${newReady}mL) — raw oils NOT touched`);
              continue;
            }

            // ⚠️ Partial or no ready stock — use what's available then deduct from raw
            let mlFromRaw = totalMl;
            if (readyMl > 0) {
              mlFromRaw = totalMl - readyMl;
              await client.query(`UPDATE formulas SET ready_stock_ml = 0 WHERE id = $1`, [formula.id]);
              await pool.query(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
                 VALUES (NULL, 'formula_ready_used', 'formula', $1, $2, $3)`,
                [formula.id, formula.name,
                 JSON.stringify({ product_code: formula.product_code, mlUsed: readyMl, remainingMl: 0, orderId: baseOrderName, sku, partial: true })]
              );
              console.log(`  ⚠️  Partial ready: ${readyMl}mL from ready, ${mlFromRaw}mL from raw oils`);
            }

            // Deduct mlFromRaw from base + oil components
            const baseMl = mlFromRaw * (parseFloat(formula.base_percentage) / 100);
            const oilMl  = mlFromRaw * (parseFloat(formula.oil_percentage)  / 100);

            for (const { code, ml, label } of [
              { code: formula.base_product_code, ml: baseMl, label: 'Base' },
              { code: formula.oil_product_code,  ml: oilMl,  label: 'Oil'  }
            ]) {
              const compResult = await client.query(
                `SELECT * FROM products WHERE "productCode" = $1 LIMIT 1 FOR UPDATE`, [code]
              );
              if (compResult.rows.length === 0) { console.log(`⚠️ Formula component not found: ${code}`); continue; }
              const comp = compResult.rows[0];
              const newStock = (parseFloat(comp.currentStock) || 0) - ml;
              await client.query(
                'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
                [newStock, Math.floor(newStock / (comp.unitPerBox || 1)), comp.id]
              );
              await client.query(
                `INSERT INTO transactions
                 (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [comp.id, comp.productCode || comp.tag, comp.name, comp.category,
                 'shopify_sale', ml, comp.unit || 'mL', newStock,
                 `Shopify Order ${baseOrderName} - Formula ${formula.product_code} ${label} (${quantity}x${sizeMl}ml)`,
                 baseOrderName]
              );
              console.log(`  ✅ ${label} debited: ${comp.name} -${ml}mL (New: ${newStock}mL)`);
            }
          } else {
            console.log(`⚠️ Formula SKU not found or size unresolvable: ${sku}`);
          }
          continue; // skip regular product lookup for this line item
        }

        // Find product by SKU — check shopifySkus values OR skuMultipliers keys
        // FOR UPDATE prevents concurrent webhooks reading stale stock on the same product
        const productResult = await client.query(`
          SELECT * FROM products
          WHERE EXISTS (
            SELECT 1 FROM jsonb_each_text("shopifySkus") WHERE value = $1
          ) OR (
            "skuMultipliers" IS NOT NULL AND "skuMultipliers" ? $1
          )
          LIMIT 1
          FOR UPDATE
        `, [sku]);

        if (productResult.rows.length > 0) {
          const product = productResult.rows[0];
          
          // ========================================================================
          // STEP 1: Calculate stock change based on product category
          // ========================================================================
          let totalDeduction;
          let notes;
          
          // Check if product is a Machine (SCENT_MACHINES or MACHINES_SPARES) - no BOM, direct debit
          if (product.category === 'SCENT_MACHINES' || product.category === 'MACHINES_SPARES') {
            // Machines: Simple quantity debit (no volume calculation, no BOM)
            totalDeduction = parseFloat(quantity);
            notes = `Shopify Order ${baseOrderName} - Fulfilled (${quantity} units)`;
            console.log(`📦 Machine SKU: ${sku}, Qty: ${quantity} units`);
          } else if (product.category === 'SA_SCENTED_PRODUCTS') {
            // Scented finished goods: 1 unit = 1 bottle sold; BOM debited separately in STEP 2
            totalDeduction = parseFloat(quantity);
            notes = `Shopify Order ${baseOrderName} - Fulfilled (${quantity} bottle(s))`;
            console.log(`🧴 Scented SKU: ${sku}, Qty: ${quantity} bottle(s)`);
          } else if (product.unit === 'units') {
            // Use per-SKU multiplier if defined, otherwise fall back to unitPerBox
            const multipliers = parseJSONB(product.skuMultipliers);
            const unitsPerSku = multipliers[sku] !== undefined
              ? parseInt(multipliers[sku])
              : (parseInt(product.unitPerBox) || 1);
            totalDeduction = unitsPerSku * parseFloat(quantity);
            notes = `Shopify Order ${baseOrderName} - Fulfilled (${quantity}x ${unitsPerSku} units)`;
            console.log(`📦 Units SKU: ${sku}, Units/box: ${unitsPerSku}, Qty: ${quantity}, Total: ${totalDeduction} units`);
          } else {
            // Oils: Calculate volume based on SKU
            const volumePerUnit = getVolumeFromSKU(sku);
            totalDeduction = volumePerUnit * parseFloat(quantity);
            notes = `Shopify Order ${baseOrderName} - Fulfilled (${quantity}x ${volumePerUnit}ml)`;
            console.log(`📊 Oil SKU: ${sku}, Volume/unit: ${volumePerUnit}ml, Qty: ${quantity}, Total: ${totalDeduction}ml`);
          }
          
          const currentStock = parseFloat(product.currentStock) || 0;
          const newStock = currentStock - totalDeduction; // Allow negative stock
          
          // Update stock
          await client.query(
            'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
            [newStock, Math.floor(newStock / (product.unitPerBox || 1)), product.id]
          );
          
          // Create transaction
          await client.query(
            `INSERT INTO transactions 
             (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              product.id,
              product.productCode || product.tag,
              product.name,
              product.category,
              'shopify_sale',
              totalDeduction,
              product.unit || 'mL',
              newStock,
              notes,
              baseOrderName
            ]
          );
          
          console.log(`✅ Debited: ${product.name} -${totalDeduction} ${product.unit} (New: ${newStock} ${product.unit})`);

          // ========================================================================
          // STEP 2: Debit BOM components
          // ========================================================================

          // ── SA_SCENTED_PRODUCTS: BOM variant = product's own SKU ──────────────
          if (product.category === 'SA_SCENTED_PRODUCTS') {
            const scentedBom = await client.query(
              'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
              [product.productCode]
            );
            if (scentedBom.rows.length > 0) {
              console.log(`🧴 Scented BOM: ${scentedBom.rows.length} components for ${product.productCode}`);
              for (const bomItem of scentedBom.rows) {
                const compRes = await client.query(
                  'SELECT * FROM products WHERE ("productCode" = $1 OR tag = $1) FOR UPDATE',
                  [bomItem.component_code]
                );
                if (compRes.rows.length === 0) {
                  console.log(`  ⚠️ Scented BOM component not found: ${bomItem.component_code}`);
                  continue;
                }
                const comp = compRes.rows[0];
                const compQty = parseFloat(bomItem.quantity) * parseFloat(quantity);
                const compNewStock = (parseFloat(comp.currentStock) || 0) - compQty;
                await client.query(
                  'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
                  [compNewStock, Math.floor(compNewStock / (comp.unitPerBox || 1)), comp.id]
                );
                await client.query(
                  `INSERT INTO transactions
                   (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
                   VALUES ($1,$2,$3,$4,'shopify_sale',$5,$6,$7,$8,$9)`,
                  [comp.id, comp.productCode || comp.tag, comp.name, comp.category,
                   compQty, bomItem.unit || comp.unit || 'mL', compNewStock,
                   `Shopify Order ${baseOrderName} - BOM (${quantity}x ${product.productCode})`,
                   baseOrderName]
                );
                console.log(`  ✅ Scented BOM: ${comp.name} -${compQty} ${bomItem.unit || comp.unit} (New: ${compNewStock})`);
              }
            } else {
              console.log(`ℹ️ No BOM for scented product ${product.productCode}`);
            }

          // ── OILS: BOM variant derived from SKU pattern ───────────────────────
          } else if (product.category !== 'SCENT_MACHINES' && product.category !== 'MACHINES_SPARES' && product.unit !== 'units') {
            const variant = getVariantFromSKU(sku);
            
            if (variant) {
              console.log(`🔍 Looking for BOM components for variant: ${variant}`);
              
              // Get BOM components for this variant
              const bomResult = await client.query(
                'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
                [variant]
              );

              if (bomResult.rows.length > 0) {
                console.log(`📦 Found ${bomResult.rows.length} BOM components for ${variant}`);

                for (const bomItem of bomResult.rows) {
                  const componentCode = bomItem.component_code;
                  const componentQty = parseFloat(bomItem.quantity) * parseFloat(quantity);

                  // Find component product — FOR UPDATE prevents concurrent deductions on same component
                  const componentResult = await client.query(
                    'SELECT * FROM products WHERE ("productCode" = $1 OR tag = $1) FOR UPDATE',
                    [componentCode]
                  );
                  
                  if (componentResult.rows.length > 0) {
                    const component = componentResult.rows[0];
                    const compCurrentStock = parseFloat(component.currentStock) || 0;
                    const compNewStock = compCurrentStock - componentQty; // Allow negative stock
                    
                    // Update component stock
                    await client.query(
                      'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
                      [compNewStock, Math.floor(compNewStock / (component.unitPerBox || 1)), component.id]
                    );
                    
                    // Create transaction for component
                    await client.query(
                      `INSERT INTO transactions 
                       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id) 
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                      [
                        component.id,
                        component.productCode || component.tag,
                        component.name,
                        component.category,
                        'shopify_sale',
                        componentQty,
                        component.unit || 'units',
                        compNewStock,
                        `Shopify Order ${baseOrderName} - BOM Component (${quantity}x ${variant})`,
                        baseOrderName
                      ]
                    );
                    
                    console.log(`  ✅ BOM component: ${component.name} -${componentQty} ${component.unit} (New: ${compNewStock})`);
                  } else {
                    console.log(`  ⚠️ BOM component not found: ${componentCode}`);
                  }
                }
              } else {
                console.log(`ℹ️ No BOM found for variant ${variant}`);
              }
            }
          } else {
            console.log(`ℹ️ Machine product - No BOM processing needed`);
          }
          
        } else {
          console.warn(`⚠️ SKU not found: ${sku} (Order ${baseOrderName}) — logged to webhook_skipped`);
          await pool.query(
            `INSERT INTO webhook_skipped (shopify_order, sku, quantity, reason, topic)
             VALUES ($1, $2, $3, 'sku_not_found', $4)`,
            [baseOrderName, sku || null, quantity || null, webhookTopic]
          );
        }
      }
      
      // Write sentinel so reversal can confirm this full order was processed
      // (distinct from the 'order_fulfilled' sentinel written by fulfillments/create)
      await client.query(`
        INSERT INTO webhook_processed (order_id, webhook_type)
        VALUES ($1, 'full_order_fulfilled')
        ON CONFLICT (order_id, webhook_type) DO NOTHING
      `, [baseOrderName]);

      await client.query('COMMIT');
      console.log(`✅ Order ${orderNumber} fulfillment processed successfully`);
      processingOrders.delete(orderNumber); // Release in-memory lock
      // Mark queue entry as completed — confirms stock was debited successfully
      await pool.query(
        `UPDATE webhook_queue SET status = 'completed', completed_at = NOW() WHERE idempotency_key = $1`,
        [orderNumber]
      );
      // Note: HTTP response was already sent above (early 200) to prevent Shopify retries.
      return; // CRITICAL: stop here — do not fall through to other webhook handlers
    }

    // ========================================================================
    // OPTION 1b: FULFILLMENT CANCELLED — reverse stock deductions
    // ========================================================================
    if (webhookTopic === 'fulfillments/update' && req.body.status !== 'cancelled') {
      // Non-cancellation update (e.g. tracking added, status change) — acknowledge and skip
      console.log(`ℹ️  fulfillments/update status=${req.body.status} — no action needed`);
      clientReleased = true; client.release();
      return res.status(200).json({ received: true, skipped: 'fulfillment_update_not_cancelled' });
    }
    if (webhookTopic === 'fulfillments/update' && req.body.status === 'cancelled') {
      console.log('↩️  Fulfillment cancelled — checking if reversal needed...');

      const fulfillmentId = orderId; // body.id = fulfillment numeric ID
      const fulfillmentIdKey = `fulfillment_${fulfillmentId}`;
      const baseOrderNameCancel = orderNumber_body ? orderNumber_body.split('.')[0] : orderNumber_body;

      // Idempotency for the reversal itself — prevents double-reversal on Shopify retries
      await pool.query(`CREATE TABLE IF NOT EXISTS webhook_processed (
        order_id TEXT NOT NULL, webhook_type TEXT NOT NULL,
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT webhook_processed_unique UNIQUE (order_id, webhook_type)
      )`);
      const reversalLock = await pool.query(`
        INSERT INTO webhook_processed (order_id, webhook_type)
        VALUES ($1, 'reversal') ON CONFLICT (order_id, webhook_type) DO NOTHING RETURNING order_id
      `, [fulfillmentIdKey]);
      if (reversalLock.rowCount === 0) {
        console.log(`ℹ️  Fulfillment ${fulfillmentId} already reversed — skipping`);
        clientReleased = true; client.release();
        return res.status(200).json({ received: true, skipped: 'already_reversed' });
      }

      // Check if processed via fulfillments/create (partial) OR via orders/fulfilled (full)
      // processedByPartial: this specific fulfillment was processed as a partial
      const processedByPartial = await pool.query(
        `SELECT 1 FROM webhook_processed WHERE order_id = $1 AND webhook_type = 'fulfillment' LIMIT 1`,
        [fulfillmentIdKey]
      );
      // processedByFullOrder: the full order was processed via orders/fulfilled (sentinel written on commit)
      // Using a dedicated sentinel avoids false positives from other partials' transactions
      const processedByOrderFulfilled = await pool.query(
        `SELECT 1 FROM webhook_processed WHERE order_id = $1 AND webhook_type = 'full_order_fulfilled' LIMIT 1`,
        [baseOrderNameCancel]
      );
      if (processedByPartial.rows.length === 0 && processedByOrderFulfilled.rows.length === 0) {
        console.log(`ℹ️  Fulfillment ${fulfillmentId} was not processed by this system — skipping reversal`);
        // Remove reversal lock since nothing was reversed
        await pool.query(`DELETE FROM webhook_processed WHERE order_id = $1 AND webhook_type = 'reversal'`, [fulfillmentIdKey]);
        clientReleased = true; client.release();
        return res.status(200).json({ received: true, skipped: 'not_processed_by_system' });
      }

      console.log(`🔄 Reversing stock for fulfillment ${fulfillmentId} (order ${baseOrderNameCancel})...`);
      res.status(200).json({ success: true, message: 'Fulfillment cancellation reversal started', fulfillmentId });

      await client.query('BEGIN');

      for (const item of line_items) {
        const { sku, quantity } = item;
        if (!sku || !quantity) continue;

        // ── Formula SKU reversal (SA_FORM_XXXXX_400 / _1L) ──────────────────
        if (sku.startsWith('SA_FORM_')) {
          const sizeMatch = sku.match(/_(\d+)$|_(1L)$/i);
          const sizeMl = sizeMatch
            ? (sizeMatch[1] === '1L' || sizeMatch[2] === '1L' ? 1000 : parseInt(sizeMatch[1]))
            : null;
          const formulaResult = await client.query(
            `SELECT * FROM formulas WHERE shopify_skus::text ILIKE $1 LIMIT 1 FOR UPDATE`, [`%${sku}%`]
          );
          if (formulaResult.rows.length > 0 && sizeMl) {
            const formula = formulaResult.rows[0];
            const totalMl    = sizeMl * parseFloat(quantity);
            const baseMl_max = totalMl * (parseFloat(formula.base_percentage) / 100);
            const oilMl_max  = totalMl * (parseFloat(formula.oil_percentage)  / 100);

            // Query what was actually debited from raw components for this formula+order.
            // Cap at baseMl_max / oilMl_max to avoid over-restoring if multiple fulfillments exist.
            const baseDebitedRes = await client.query(
              `SELECT COALESCE(SUM(quantity), 0) AS debited FROM transactions
               WHERE shopify_order_id = $1 AND type = 'shopify_sale'
                 AND product_code = $2 AND notes ILIKE $3`,
              [baseOrderNameCancel, formula.base_product_code, `%Formula ${formula.product_code} Base%`]
            );
            const oilDebitedRes = await client.query(
              `SELECT COALESCE(SUM(quantity), 0) AS debited FROM transactions
               WHERE shopify_order_id = $1 AND type = 'shopify_sale'
                 AND product_code = $2 AND notes ILIKE $3`,
              [baseOrderNameCancel, formula.oil_product_code, `%Formula ${formula.product_code} Oil%`]
            );
            const actualBaseMl = Math.min(parseFloat(baseDebitedRes.rows[0].debited) || 0, baseMl_max);
            const actualOilMl  = Math.min(parseFloat(oilDebitedRes.rows[0].debited) || 0, oilMl_max);
            const readyMlUsed  = Math.max(0, totalMl - actualBaseMl - actualOilMl);

            console.log(`↩️  Formula reversal: ${sku} → ${formula.name} | ${quantity}x${sizeMl}ml = ${totalMl}ml | Raw Base: +${actualBaseMl}ml, Raw Oil: +${actualOilMl}ml, Ready: +${readyMlUsed}ml`);

            // Restore raw components only for amounts actually debited
            for (const { code, ml, label } of [
              { code: formula.base_product_code, ml: actualBaseMl, label: 'Base' },
              { code: formula.oil_product_code,  ml: actualOilMl,  label: 'Oil'  }
            ]) {
              if (ml <= 0) { console.log(`  ℹ️  Formula ${label} not debited — skipping`); continue; }
              const compResult = await client.query(
                `SELECT * FROM products WHERE "productCode" = $1 LIMIT 1 FOR UPDATE`, [code]
              );
              if (compResult.rows.length === 0) { console.log(`⚠️ Formula component not found for reversal: ${code}`); continue; }
              const comp = compResult.rows[0];
              const newStock = (parseFloat(comp.currentStock) || 0) + ml;
              await client.query(
                'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
                [newStock, Math.floor(newStock / (comp.unitPerBox || 1)), comp.id]
              );
              await client.query(
                `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
                 VALUES ($1,$2,$3,$4,'shopify_reversal',$5,$6,$7,$8,$9)`,
                [comp.id, comp.productCode, comp.name, comp.category, ml, comp.unit || 'mL', newStock,
                 `Reversal: Shopify Order ${baseOrderNameCancel} - Formula ${formula.product_code} ${label} cancelled (${quantity}x${sizeMl}ml)`,
                 baseOrderNameCancel]
              );
              console.log(`  ↩️  ${label} restored: ${comp.name} +${ml}mL (New: ${newStock}mL)`);
            }

            // Restore ready stock for the portion that was served from it
            if (readyMlUsed > 0) {
              const currentReady = parseFloat(formula.ready_stock_ml) || 0;
              const newReady = currentReady + readyMlUsed;
              await client.query(`UPDATE formulas SET ready_stock_ml = $1 WHERE id = $2`, [newReady, formula.id]);
              await pool.query(
                `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
                 VALUES (NULL, 'formula_ready_restored', 'formula', $1, $2, $3)`,
                [formula.id, formula.name,
                 JSON.stringify({ product_code: formula.product_code, mlRestored: readyMlUsed, newTotalMl: newReady, orderId: baseOrderNameCancel, sku })]
              );
              console.log(`  ↩️  Ready stock restored: +${readyMlUsed}mL (New: ${newReady}mL)`);
            }
          } else {
            console.log(`⚠️ Formula SKU not found for reversal: ${sku}`);
          }
          continue;
        }

        const productResult = await client.query(
          `SELECT * FROM products
           WHERE EXISTS (SELECT 1 FROM jsonb_each_text("shopifySkus") WHERE value = $1)
              OR ("skuMultipliers" IS NOT NULL AND "skuMultipliers" ? $1)
           LIMIT 1
           FOR UPDATE`,
          [sku]
        );
        if (productResult.rows.length === 0) {
          console.warn(`⚠️ SKU not found for reversal: ${sku} (Order ${baseOrderNameCancel}) — logged to webhook_skipped`);
          await pool.query(
            `INSERT INTO webhook_skipped (shopify_order, sku, quantity, reason, topic)
             VALUES ($1, $2, $3, 'sku_not_found_reversal', 'fulfillments/update')`,
            [baseOrderNameCancel, sku || null, quantity || null]
          );
          continue;
        }

        const product = productResult.rows[0];
        let totalReversal;
        let reversalNotes;

        if (product.category === 'SCENT_MACHINES' || product.category === 'MACHINES_SPARES') {
          totalReversal = parseFloat(quantity);
          reversalNotes = `Reversal: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled (${quantity} units)`;
        } else if (product.category === 'SA_SCENTED_PRODUCTS') {
          totalReversal = parseFloat(quantity);
          reversalNotes = `Reversal: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled (${quantity} bottle(s))`;
        } else if (product.unit === 'units') {
          const multipliers = parseJSONB(product.skuMultipliers);
          const unitsPerSku = multipliers[sku] !== undefined
            ? parseInt(multipliers[sku])
            : (parseInt(product.unitPerBox) || 1);
          totalReversal = unitsPerSku * parseFloat(quantity);
          reversalNotes = `Reversal: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled (${quantity}x ${unitsPerSku} units)`;
        } else {
          const volumePerUnit = getVolumeFromSKU(sku);
          totalReversal = volumePerUnit * parseFloat(quantity);
          reversalNotes = `Reversal: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled (${quantity}x ${volumePerUnit}ml)`;
        }

        const newStock = (parseFloat(product.currentStock) || 0) + totalReversal;
        await client.query(
          'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
          [newStock, Math.floor(newStock / (product.unitPerBox || 1)), product.id]
        );
        await client.query(
          `INSERT INTO transactions
           (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [product.id, product.productCode || product.tag, product.name, product.category,
           'shopify_reversal', totalReversal, product.unit || 'mL', newStock, reversalNotes, baseOrderNameCancel]
        );
        console.log(`↩️  Reversed: ${product.name} +${totalReversal} ${product.unit} (New: ${newStock})`);

        // Also reverse BOM components
        if (product.category === 'SA_SCENTED_PRODUCTS') {
          // Scented products: BOM variant = product's own SKU
          const scentedBomRev = await client.query(
            'SELECT * FROM bom WHERE variant = $1 ORDER BY seq',
            [product.productCode]
          );
          for (const bomItem of scentedBomRev.rows) {
            const compRes = await client.query(
              'SELECT * FROM products WHERE ("productCode" = $1 OR tag = $1) FOR UPDATE',
              [bomItem.component_code]
            );
            if (compRes.rows.length === 0) continue;
            const comp = compRes.rows[0];
            const compQty = parseFloat(bomItem.quantity) * parseFloat(quantity);
            const compNewStock = (parseFloat(comp.currentStock) || 0) + compQty;
            await client.query(
              'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
              [compNewStock, Math.floor(compNewStock / (comp.unitPerBox || 1)), comp.id]
            );
            await client.query(
              `INSERT INTO transactions
               (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
               VALUES ($1,$2,$3,$4,'shopify_reversal',$5,$6,$7,$8,$9)`,
              [comp.id, comp.productCode || comp.tag, comp.name, comp.category,
               compQty, bomItem.unit || comp.unit || 'mL', compNewStock,
               `Reversal BOM: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled (${product.productCode})`,
               baseOrderNameCancel]
            );
            console.log(`  ↩️  Scented BOM reversed: ${comp.name} +${compQty} ${bomItem.unit || comp.unit}`);
          }
        } else if (product.category !== 'SCENT_MACHINES' && product.category !== 'MACHINES_SPARES' && product.unit !== 'units') {
          // Oils: BOM variant derived from SKU pattern
          const variant = getVariantFromSKU(sku);
          if (variant) {
            const bomResult = await client.query('SELECT * FROM bom WHERE variant = $1 ORDER BY seq', [variant]);
            for (const bomItem of bomResult.rows) {
              const componentResult = await client.query(
                'SELECT * FROM products WHERE ("productCode" = $1 OR tag = $1) FOR UPDATE',
                [bomItem.component_code]
              );
              if (componentResult.rows.length === 0) continue;
              const component = componentResult.rows[0];
              const compQty = parseFloat(bomItem.quantity) * parseFloat(quantity);
              const compNewStock = (parseFloat(component.currentStock) || 0) + compQty;
              await client.query(
                'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
                [compNewStock, Math.floor(compNewStock / (component.unitPerBox || 1)), component.id]
              );
              await client.query(
                `INSERT INTO transactions
                 (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [component.id, component.productCode || component.tag, component.name, component.category,
                 'shopify_reversal', compQty, component.unit || 'units', compNewStock,
                 `Reversal BOM: Shopify Order ${baseOrderNameCancel} - Fulfillment ${fulfillmentId} cancelled`,
                 baseOrderNameCancel]
              );
              console.log(`  ↩️  BOM reversed: ${component.name} +${compQty}`);
            }
          }
        }
      }

      await client.query('COMMIT');

      // Remove fulfillment lock so audit trail is clean
      await pool.query(
        `DELETE FROM webhook_processed WHERE order_id = $1 AND webhook_type = 'fulfillment'`,
        [fulfillmentIdKey]
      );

      console.log(`✅ Reversal complete for fulfillment ${fulfillmentId}`);
      clientReleased = true; client.release();
      return;
    }

    // ========================================================================
    // OPTION 2: ORDER CREATION - Add to incoming orders
    // ========================================================================
    if (webhookTopic === 'orders/create') {
      console.log('📝 Order Creation - Adding to incoming orders...');
      
      for (const item of line_items) {
        const { sku, quantity } = item;
        
        if (!sku) continue;
        
        const productResult = await pool.query(`
          SELECT * FROM products
          WHERE EXISTS (
            SELECT 1 FROM jsonb_each_text("shopifySkus") WHERE value = $1
          )
          LIMIT 1
        `, [sku]);
        
        if (productResult.rows.length > 0) {
          const product = productResult.rows[0];
          const incomingOrders = parseJSONB(product.incoming_orders, []);
          
          incomingOrders.push({
            orderNumber,
            sku,
            quantity,
            receivedAt: new Date().toISOString()
          });
          
          await pool.query(
            'UPDATE products SET incoming_orders = $1 WHERE id = $2',
            [JSON.stringify(incomingOrders), product.id]
          );
          
          console.log(`📋 Incoming order added: ${product.name} - Order ${orderNumber}`);
        }
      }
      
      return res.status(200).json({ 
        success: true, 
        message: 'Incoming order added',
        order: orderNumber 
      });
    }
    
    // Unknown webhook type
    console.log('⚠️ Unknown webhook type:', webhookTopic);
    res.status(200).json({ received: true, message: 'Webhook received but not processed' });
    
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch(e) {}
    }
    console.error('❌ Webhook error:', error);
    // Clean up in-memory lock so a manual retry can be attempted if needed
    if (orderNumber) processingOrders.delete(orderNumber);
    // Only send error response if we haven't already responded (early 200 for fulfillment)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  } finally {
    if (client && !clientReleased) client.release();
  }
}

// ========================================================================
// PURCHASE ORDERS - Add Incoming Order
// ========================================================================
router.post('/products/:id/incoming', async (req, res) => {
  try {
    const { id } = req.params;
    const { orderNumber, quantity, supplier, notes, addedBy, userId, estimatedDeliveryDate } = req.body;

    if (!orderNumber || !quantity) {
      return res.status(400).json({ error: 'Order number and quantity are required' });
    }

    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (productResult.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = productResult.rows[0];

    await pool.query(
      `INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, notes, added_by, created_by, estimated_delivery_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, orderNumber, parseFloat(quantity), supplier || product.supplier || null, notes || null, addedBy || 'manual', userId || null, estimatedDeliveryDate || null]
    );

    const posResult = await pool.query(
      `SELECT id, order_number, quantity, quantity_received, supplier, status, notes, added_at, added_by, estimated_delivery_date
       FROM purchase_orders WHERE product_id = $1 AND status IN ('pending','partial') ORDER BY added_at ASC`,
      [id]
    );
    const incomingOrders = posResult.rows.map(po => ({
      id: po.id, orderNumber: po.order_number, quantity: parseFloat(po.quantity),
      quantityReceived: parseFloat(po.quantity_received) || 0,
      supplier: po.supplier || '', status: po.status, notes: po.notes || '',
      addedAt: po.added_at, addedBy: po.added_by || '',
      estimatedDeliveryDate: po.estimated_delivery_date || null
    }));

    // Audit log — po_created
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'po_created', 'product', $2, $3, $4)`,
        [req.user.id, id, product.name, JSON.stringify({
          orderNumber,
          quantity: parseFloat(quantity),
          unit: product.unit,
          estimatedDeliveryDate: estimatedDeliveryDate || null,
          productCode: product.productCode || product.tag,
          category: product.category
        })]
      );
    } catch (auditErr) { console.warn('⚠️ audit_log (po_created) failed:', auditErr.message); }

    console.log(`📋 PO added: ${product.name} — ${orderNumber} (${quantity} ${product.unit})`);
    res.json({ success: true, incomingOrders, message: 'Incoming order added successfully' });
  } catch (error) {
    console.error('Add incoming order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/purchase-orders — all pending/partial POs with product info (used by Dashboard)
router.get('/purchase-orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        po.id, po.order_number, po.quantity, po.quantity_received,
        po.status, po.supplier, po.notes, po.added_at, po.added_by,
        po.estimated_delivery_date,
        p.id AS product_id, p.name AS product_name,
        p."productCode" AS product_code, p.unit, p.category
      FROM purchase_orders po
      JOIN products p ON po.product_id = p.id
      WHERE po.status IN ('pending', 'partial')
      ORDER BY po.estimated_delivery_date ASC NULLS LAST, po.added_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/purchase-orders/:poId', async (req, res) => {
  try {
    const id = parseInt(req.params.poId);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    const cancelledByUserId = req.query.userId ? parseInt(req.query.userId) : null;

    // Fetch PO + product info before deleting
    const poResult = await pool.query(
      `SELECT po.product_id, po.order_number, po.quantity,
              p.name AS product_name, p."productCode" AS product_code, p.category, p.unit AS product_unit
       FROM purchase_orders po
       JOIN products p ON p.id = po.product_id
       WHERE po.id = $1`,
      [id]
    );
    if (poResult.rows.length === 0) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    const po = poResult.rows[0];

    // Delete from purchase_orders table
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]);

    // Also remove matching entry from JSONB incoming_orders so runStartupMigrations
    // doesn't re-insert it on the next server restart
    await pool.query(`
      UPDATE products
      SET incoming_orders = (
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(incoming_orders, '[]'::jsonb)) item
        WHERE item->>'orderNumber' != $1
      )
      WHERE id = $2
    `, [po.order_number, po.product_id]);

    // Audit log — po_cancelled
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'po_cancelled', 'product', $2, $3, $4)`,
        [req.user.id, po.product_id, po.product_name, JSON.stringify({
          orderNumber: po.order_number,
          quantity: parseFloat(po.quantity),
          unit: po.product_unit,
          productCode: po.product_code,
          category: po.category
        })]
      );
    } catch (auditErr) { console.warn('⚠️ audit_log (po_cancelled) failed:', auditErr.message); }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete PO error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// RECEIVE INCOMING ORDER - Mark as Received and Update Stock
// ========================================================================
// RECEIVE PURCHASE ORDER — update stock, mark PO as received/partial
// ========================================================================
router.post('/purchase-orders/:poId/receive', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { quantityReceived, notes, receivedBy, userId } = req.body;
    const receivedQty = parseFloat(quantityReceived);
    if (!receivedQty || isNaN(receivedQty) || receivedQty <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quantityReceived must be a positive number' });
    }

    // Get PO
    const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.poId]);
    if (poResult.rows.length === 0) throw new Error('Purchase order not found');
    const po = poResult.rows[0];

    // Validate cannot receive more than remaining balance
    const alreadyReceived = parseFloat(po.quantity_received) || 0;
    const remaining = parseFloat(po.quantity) - alreadyReceived;
    if (receivedQty > remaining + 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot receive ${receivedQty} — only ${remaining.toFixed(3)} remaining on this PO (ordered: ${po.quantity}, already received: ${alreadyReceived})`
      });
    }

    // Get product — FOR UPDATE prevents concurrent receives on the same product from reading stale stock
    const productResult = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [po.product_id]);
    if (productResult.rows.length === 0) throw new Error('Product not found');
    const product = productResult.rows[0];

    // Update stock
    const newStock = parseFloat(product.currentStock || 0) + receivedQty;
    await client.query(
      'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
      [newStock, Math.floor(newStock / (product.unitPerBox || 1)), product.id]
    );

    // Mark PO as received or partial
    const newQtyReceived = parseFloat(po.quantity_received) + receivedQty;
    const newStatus = newQtyReceived >= parseFloat(po.quantity) - 0.001 ? 'received' : 'partial';
    await client.query(
      `UPDATE purchase_orders SET quantity_received = $1, status = $2, received_at = NOW(), received_by = $3, updated_at = NOW() WHERE id = $4`,
      [newQtyReceived, newStatus, receivedBy || null, po.id]
    );

    // Create transaction
    await client.query(
      `INSERT INTO transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        product.id, product.productCode || product.tag, product.name, product.category,
        'add', receivedQty, product.unit || 'units', newStock,
        `PO Received: ${po.order_number} - ${notes || 'Incoming order received'}${receivedBy ? ` (by ${receivedBy})` : ''}`,
        userId || null
      ]
    );

    // Audit log inside transaction — if this fails the whole receive rolls back (consistent)
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'po_received', 'product', $2, $3, $4)`,
      [req.user.id, product.id, product.name, JSON.stringify({
        orderNumber: po.order_number,
        quantityReceived: receivedQty,
        totalQuantity: parseFloat(po.quantity),
        receiveType: newStatus === 'received' ? 'full' : 'partial',
        unit: product.unit,
        productCode: product.productCode || product.tag,
        category: product.category
      })]
    );

    await client.query('COMMIT');
    console.log(`✅ PO Received: ${product.name} — ${po.order_number} (+${receivedQty} ${product.unit}) [${newStatus}]`);

    res.json({ success: true, newStock, status: newStatus, message: `PO ${newStatus}. Stock updated.` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Receive PO error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// STOCK RECONCILIATION — compares currentStock to last transaction balance
// ========================================================================
router.get('/stock-reconciliation', async (req, res) => {
  try {
    // For each product that has at least one transaction, compare currentStock
    // to the balance_after of the most recent transaction. Any gap means stock
    // was changed outside the transaction system (direct DB update, trigger, etc.)
    const result = await pool.query(`
      SELECT
        p.id,
        p."productCode",
        p.name,
        p.category,
        p."currentStock"      AS current_stock,
        last_tx.balance_after AS last_tx_balance,
        last_tx.created_at    AS last_tx_at,
        last_tx.type          AS last_tx_type,
        last_tx.notes         AS last_tx_notes,
        ROUND((p."currentStock" - last_tx.balance_after)::numeric, 2) AS discrepancy
      FROM products p
      JOIN LATERAL (
        SELECT balance_after, created_at, type, notes
        FROM transactions
        WHERE product_id = p.id::text
        ORDER BY created_at DESC
        LIMIT 1
      ) last_tx ON true
      WHERE ABS(p."currentStock" - last_tx.balance_after) > 0.01
      ORDER BY ABS(p."currentStock" - last_tx.balance_after) DESC
    `);

    // Also surface any direct_stock_changes from the trigger (last 30 days)
    let directChanges = [];
    try {
      const dc = await pool.query(`
        SELECT product_id, product_code, old_stock, new_stock,
               ROUND((new_stock - old_stock)::numeric, 2) AS delta,
               changed_at, changed_by
        FROM direct_stock_changes
        WHERE changed_at > NOW() - INTERVAL '30 days'
        ORDER BY changed_at DESC
        LIMIT 50
      `);
      directChanges = dc.rows;
    } catch (_) { /* table may not exist on older instances */ }

    res.json({
      discrepancies: result.rows,
      discrepancy_count: result.rows.length,
      direct_changes: directChanges,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Reconciliation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// FORMULAS / BLENDS
// ========================================================================

// ── Helper: create 400ml + 1L products in Shopify for a formula ──────────
async function createFormulaInShopify(formula) {
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_PASSWORD;
  if (!process.env.SHOPIFY_STORE_NAME || !accessToken)
    throw new Error('Shopify credentials not configured');

  const skus = Array.isArray(formula.shopify_skus)
    ? formula.shopify_skus
    : JSON.parse(formula.shopify_skus || '[]');

  const sku400 = skus.find(s => s.endsWith('_400')) || null;
  const sku1L  = skus.find(s => /_(1L|1000)$/i.test(s)) || null;

  const description =
    `<p><strong>Base:</strong> ${formula.base_product_code} &mdash; ${formula.base_percentage}%</p>` +
    `<p><strong>Oil:</strong> ${formula.oil_product_code} &mdash; ${formula.oil_percentage}%</p>` +
    `<p>Formula Code: ${formula.product_code} | ${formula.tag}</p>`;

  const variants = [
    sku400 ? { suffix: '- 400ml', sku: sku400, price: '165.00', weight: 400  } : null,
    sku1L  ? { suffix: '- 1L',   sku: sku1L,  price: '218.90', weight: 1000 } : null,
  ].filter(Boolean);

  const url = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2025-10/products.json`;
  const added = [], failed = [];

  for (const v of variants) {
    const title = `${formula.name} ${v.suffix}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ product: {
        title,
        body_html: description,
        vendor: 'Scent Australia',
        product_type: 'Fragrance Oil Blend',
        status: 'draft',
        tags: `FORMULA,BLEND,${formula.product_code},${formula.tag}`,
        variants: [{ sku: v.sku, price: v.price, weight: v.weight, weight_unit: 'g',
          inventory_management: null, inventory_policy: 'continue' }]
      }})
    });
    if (resp.ok) {
      const data = await resp.json();
      added.push({ sku: v.sku, title, shopifyId: data.product.id });
      console.log(`✅ Shopify formula product created: "${title}" (${v.sku})`);
    } else {
      const errText = await resp.text();
      failed.push({ sku: v.sku, error: errText });
      console.error(`❌ Shopify formula product failed (${v.sku}):`, errText);
    }
  }
  return { added, failed };
}

// ── Next sequential formula code ─────────────────────────────────────────
router.get('/formulas/next-code', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_code FROM formulas ORDER BY product_code DESC LIMIT 1`
    );
    let nextNum = 1;
    if (result.rows.length > 0) {
      const match = result.rows[0].product_code.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const padded = String(nextNum).padStart(5, '0');
    res.json({
      tag:          `#SAFORM${padded}`,
      product_code: `FORM_${padded}`,
      shopify_skus: `SA_FORM_${padded}_400, SA_FORM_${padded}_1L`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/formulas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM formulas ORDER BY product_code');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Adjust ready formula stock (set absolute value) ──────────────────────
router.put('/formulas/:id/ready-stock/adjust', async (req, res) => {
  const { quantityMl, userId } = req.body;
  const qty = parseFloat(quantityMl);
  if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Invalid quantity' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(`SELECT ready_stock_ml, name FROM formulas WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (prev.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Formula not found' }); }

    const result = await client.query(
      `UPDATE formulas SET ready_stock_ml = $1 WHERE id = $2 RETURNING *`,
      [qty, req.params.id]
    );
    const formula = result.rows[0];
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'formula_ready_adjusted', 'formula', $2, $3, $4)`,
      [req.user.id, formula.id, formula.name,
       JSON.stringify({ product_code: formula.product_code, previousMl: parseFloat(prev.rows[0].ready_stock_ml) || 0, newMl: qty })]
    );
    await client.query('COMMIT');
    res.json({ success: true, ready_stock_ml: qty });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Receive ready formula stock from technicians ──────────────────────────
router.post('/formulas/:id/ready-stock/receive', async (req, res) => {
  const { quantityMl, notes, userId } = req.body;
  const qty = parseFloat(quantityMl);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Invalid quantity' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE formulas SET ready_stock_ml = COALESCE(ready_stock_ml, 0) + $1 WHERE id = $2 RETURNING *`,
      [qty, req.params.id]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Formula not found' }); }

    const formula = result.rows[0];
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'formula_ready_received', 'formula', $2, $3, $4)`,
      [req.user.id, formula.id, formula.name,
       JSON.stringify({ product_code: formula.product_code, quantityMl: qty, notes: notes || '', newTotalMl: parseFloat(formula.ready_stock_ml) })]
    );
    await client.query('COMMIT');
    res.json({ success: true, ready_stock_ml: parseFloat(formula.ready_stock_ml) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/formulas', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage formulas' });
    const { tag, product_code, name, shopify_skus = [], base_product_code, base_percentage,
            oil_product_code, oil_percentage, userId, publishToShopify } = req.body;
    if (!tag || !product_code || !name || !base_product_code || !base_percentage || !oil_product_code || !oil_percentage)
      return res.status(400).json({ error: 'Missing required fields' });

    const result = await pool.query(
      `INSERT INTO formulas (tag, product_code, name, shopify_skus, base_product_code, base_percentage, oil_product_code, oil_percentage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tag, product_code, name, JSON.stringify(shopify_skus), base_product_code, base_percentage, oil_product_code, oil_percentage]
    );
    const formula = result.rows[0];

    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'formula_created', 'formula', $2, $3, $4)`,
        [req.user.id, formula.id, name,
         JSON.stringify({ product_code, tag, base_product_code, base_percentage, oil_product_code, oil_percentage, shopify_skus })]
      );
    } catch (e) { console.warn('audit_log (formula_created):', e.message); }

    let shopifyResult = null;
    if (publishToShopify) {
      try { shopifyResult = await createFormulaInShopify(formula); }
      catch (e) { shopifyResult = { error: e.message }; }
    }

    res.json({ ...formula, shopifyResult });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/formulas/:id', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage formulas' });
    const { tag, product_code, name, shopify_skus, base_product_code, base_percentage,
            oil_product_code, oil_percentage, userId } = req.body;

    const existing = await pool.query('SELECT * FROM formulas WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Formula not found' });
    const old = existing.rows[0];

    const result = await pool.query(
      `UPDATE formulas SET tag=$1, product_code=$2, name=$3, shopify_skus=$4,
       base_product_code=$5, base_percentage=$6, oil_product_code=$7, oil_percentage=$8
       WHERE id=$9 RETURNING *`,
      [tag, product_code, name, JSON.stringify(shopify_skus), base_product_code,
       base_percentage, oil_product_code, oil_percentage, req.params.id]
    );

    const changes = {};
    if (parseFloat(old.base_percentage) !== parseFloat(base_percentage))
      changes.base_percentage = { from: old.base_percentage, to: base_percentage };
    if (parseFloat(old.oil_percentage) !== parseFloat(oil_percentage))
      changes.oil_percentage  = { from: old.oil_percentage, to: oil_percentage };
    if (old.base_product_code !== base_product_code)
      changes.base_product_code = { from: old.base_product_code, to: base_product_code };
    if (old.oil_product_code !== oil_product_code)
      changes.oil_product_code  = { from: old.oil_product_code, to: oil_product_code };
    if (old.name !== name) changes.name = { from: old.name, to: name };

    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'formula_updated', 'formula', $2, $3, $4)`,
        [req.user.id, req.params.id, name, JSON.stringify({ changes, product_code })]
      );
    } catch (e) { console.warn('audit_log (formula_updated):', e.message); }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/formulas/:id', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage formulas' });
    const userId = req.user.id;
    const existing = await pool.query('SELECT * FROM formulas WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.json({ success: true });
    const formula = existing.rows[0];

    await pool.query('DELETE FROM formulas WHERE id = $1', [req.params.id]);

    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES ($1, 'formula_deleted', 'formula', $2, $3, $4)`,
        [req.user.id, req.params.id, formula.name,
         JSON.stringify({ product_code: formula.product_code, tag: formula.tag })]
      );
    } catch (e) { console.warn('audit_log (formula_deleted):', e.message); }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// PO BULK IMPORT — Template download + Excel upload + preview + confirm
// ========================================================================

// ── GET /api/po/template — Download blank Excel template for Payal
router.get('/po/template', async (req, res) => {
  try {
    const { utils, write } = await import('xlsx');
    const wb = utils.book_new();

    // Header row + two example rows so Payal understands the format
    const ws = utils.aoa_to_sheet([
      ['product_code', 'tag', 'name', 'po_number', 'quantity_ml', 'eta', 'notes'],
      ['FRAG_0045', 'SA-0045', 'Dream (example — delete this row)', 'PO-2026-001', '5L', '15/05/2026', 'Can use L (litres) or mL e.g. 5L = 5000mL'],
      ['FRAG_0083', 'SA-0083', 'Zen Garden (example — delete this row)', 'PO-2026-002', '10000', '20/05/2026', ''],
    ]);

    // Column widths
    ws['!cols'] = [
      { wch: 16 }, // product_code
      { wch: 14 }, // tag
      { wch: 32 }, // name
      { wch: 16 }, // po_number
      { wch: 14 }, // quantity_ml
      { wch: 14 }, // eta
      { wch: 28 }, // notes
    ];

    utils.book_append_sheet(wb, ws, 'PO Import');
    const buffer = write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="PO_Import_Template.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('Template generation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/po/import/preview — Parse uploaded Excel, match products, return preview (no DB writes)
router.post('/po/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { read, utils } = await import('xlsx');
    const fileData = await fs.readFile(req.file.path);
    const workbook = read(fileData, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = utils.sheet_to_json(sheet, { defval: '', cellDates: true });

    // Clean up temp file if saved to disk
    if (req.file.path) {
      try { await fs.unlink(req.file.path); } catch (_) {}
    }

    if (!rows.length) return res.status(400).json({ error: 'Spreadsheet is empty' });

    // Load all products once for matching
    const productsResult = await pool.query(
      `SELECT id, name, "productCode", tag, supplier, unit, category FROM products ORDER BY name`
    );
    const allProducts = productsResult.rows;

    // Build lookup maps
    const byCode = {};
    const byTag  = {};
    for (const p of allProducts) {
      if (p.productCode) byCode[p.productCode.trim().toLowerCase()] = p;
      if (p.tag)         byTag[p.tag.trim().toLowerCase()]           = p;
    }

    // Load existing PO numbers to detect duplicates
    const existingPOs = await pool.query(
      `SELECT product_id, order_number FROM purchase_orders WHERE status IN ('pending','partial')`
    );
    const existingSet = new Set(existingPOs.rows.map(r => `${r.product_id}::${r.order_number.trim().toLowerCase()}`));

    const preview = rows.map((row, idx) => {
      const rawCode  = String(row['product_code'] || row['Product_Code'] || row['ProductCode'] || '').trim();
      const rawTag   = String(row['tag']          || row['Tag']          || '').trim();
      const rawName  = String(row['name']         || row['Name']         || '').trim();
      const poNumber = String(row['po_number']    || row['PO_Number']    || row['PO Number']  || '').trim();
      const qtyRaw   = String(row['quantity_ml']  || row['Quantity_ml']  || row['Quantity (ml)'] || row['quantity_l'] || '').trim();
      const notes    = String(row['notes']        || row['Notes']        || '').trim();

      // ETA: Excel stores dates as JS Date objects (cellDates:true) or as serial numbers.
      // Convert to DD/MM/YYYY for display; the confirm route will re-parse to YYYY-MM-DD for DB.
      const etaCell = row['eta'] || row['ETA'] || '';
      let etaRaw = '';
      if (etaCell instanceof Date && !isNaN(etaCell)) {
        const d = etaCell;
        etaRaw = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      } else if (typeof etaCell === 'number' && etaCell > 0) {
        // Fallback: Excel serial number (shouldn't happen with cellDates:true, but just in case)
        const d = new Date(Math.round((etaCell - 25569) * 86400 * 1000));
        etaRaw = `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
      } else {
        etaRaw = String(etaCell).trim();
      }

      // Validation
      const errors = [];
      if (!rawCode && !rawTag) errors.push('product_code or tag required');
      if (!poNumber)           errors.push('po_number required');
      // Accept "5L" / "5l" / "5 L" — convert to mL automatically
      const qtyIsLitres = /^\d[\d.,]*\s*[lL]$/.test(qtyRaw);
      const qtyNumeric  = parseFloat(qtyRaw.replace(/[lL]/gi, '').replace(',', '.').trim());
      const qty         = qtyIsLitres ? qtyNumeric * 1000 : qtyNumeric;
      if (!qtyRaw || isNaN(qty) || qty <= 0) errors.push('quantity_ml must be a positive number (e.g. 5000 or 5L)');

      // Product matching: try productCode first, then tag
      let matched = null;
      if (rawCode) matched = byCode[rawCode.toLowerCase()];
      if (!matched && rawTag) matched = byTag[rawTag.toLowerCase()];

      // Name mismatch warning (non-blocking)
      const nameMismatch = matched && rawName && matched.name.toLowerCase() !== rawName.toLowerCase();

      // Duplicate check
      const isDuplicate = matched && poNumber
        ? existingSet.has(`${matched.id}::${poNumber.toLowerCase()}`)
        : false;

      // Status
      let status = 'matched';
      if (errors.length > 0)  status = 'error';
      else if (!matched)       status = 'not_found';
      else if (isDuplicate)    status = 'duplicate';
      else if (nameMismatch)   status = 'name_mismatch'; // matched but name differs — still importable

      return {
        rowIndex: idx,
        rawCode,
        rawTag,
        rawName,
        poNumber,
        quantityMl: isNaN(qty) ? null : qty,
        quantityConverted: qtyIsLitres,
        etaRaw,
        notes,
        matched: matched ? { id: matched.id, name: matched.name, productCode: matched.productCode, tag: matched.tag, unit: matched.unit, supplier: matched.supplier, category: matched.category } : null,
        nameMismatch,
        isDuplicate,
        errors,
        status,
        // importable = ready to go
        importable: status === 'matched' || status === 'name_mismatch',
      };
    });

    res.json({ preview, total: rows.length });
  } catch (err) {
    console.error('PO import preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/po/import/confirm — Create POs for confirmed rows
router.post('/po/import/confirm', async (req, res) => {
  try {
    const { rows, userId, importedBy } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows to import' });
    }

    // Re-check duplicates at confirm time (race condition protection)
    const existingPOs = await pool.query(
      `SELECT product_id, order_number FROM purchase_orders WHERE status IN ('pending','partial')`
    );
    const existingSet = new Set(existingPOs.rows.map(r => `${r.product_id}::${r.order_number.trim().toLowerCase()}`));

    let created = 0, skipped = 0;
    const skippedReasons = [];

    for (const row of rows) {
      const { productId, poNumber, quantityMl, etaRaw, notes, productName, productUnit, productCategory, productCode } = row;

      // Final duplicate guard
      if (existingSet.has(`${productId}::${poNumber.trim().toLowerCase()}`)) {
        skipped++;
        skippedReasons.push(`${poNumber} (duplicate)`);
        continue;
      }

      // Parse ETA — accept DD/MM/YYYY or YYYY-MM-DD
      let eta = null;
      if (etaRaw) {
        const dmY = etaRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dmY) {
          eta = `${dmY[3]}-${dmY[2].padStart(2,'0')}-${dmY[1].padStart(2,'0')}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(etaRaw)) {
          eta = etaRaw;
        }
        // Reject implausible dates (before 2020 or more than 5 years in future)
        if (eta) {
          const etaYear = parseInt(eta.slice(0, 4));
          if (etaYear < 2020 || etaYear > new Date().getFullYear() + 5) {
            eta = null;
          }
        }
      }

      await pool.query(
        `INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, notes, added_by, created_by, estimated_delivery_date)
         SELECT id, $2, $3, supplier, $4, $5, $6, $7 FROM products WHERE id = $1`,
        [productId, poNumber, parseFloat(quantityMl), notes || null, importedBy || 'import', userId || null, eta]
      );

      // Audit log
      try {
        await pool.query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
           VALUES ($1, 'po_created', 'product', $2, $3, $4)`,
          [req.user.id, productId, productName, JSON.stringify({
            orderNumber: poNumber,
            quantity: parseFloat(quantityMl),
            unit: productUnit,
            estimatedDeliveryDate: eta,
            productCode,
            category: productCategory,
            source: 'bulk_import',
          })]
        );
      } catch (auditErr) { console.warn('audit_log po_created (import) failed:', auditErr.message); }

      existingSet.add(`${productId}::${poNumber.trim().toLowerCase()}`); // prevent dupes within same batch
      created++;
    }

    console.log(`📦 PO Bulk Import: ${created} created, ${skipped} skipped`);
    res.json({ success: true, created, skipped, skippedReasons });
  } catch (err) {
    console.error('PO import confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// REPLENISHMENT DASHBOARD
// ========================================================================

// ── Migration: create forecasts table + suppliers table + add lead_time to products (idempotent)
router.get('/migrate-replenishment', async (req, res) => {
  try {
    if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can run migrations' });
    // 1. lead_time column on products (override per product)
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time INTEGER DEFAULT NULL`);

    // 2. forecasts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS forecasts (
        id                SERIAL PRIMARY KEY,
        product_code      TEXT NOT NULL,
        forecast_120_days NUMERIC(12,2) NOT NULL DEFAULT 0,
        import_date       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        imported_by       TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_forecasts_product_code ON forecasts(product_code)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_forecasts_import_date ON forecasts(import_date DESC)`);

    // 3. suppliers table — stores default lead times per supplier name
    await pool.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        lead_time  INTEGER NOT NULL DEFAULT 30,
        notes      TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 4. Seed known suppliers (ON CONFLICT = update lead_time if already exists)
    const knownSuppliers = [
      { name: 'Luxaroma',         lead_time: 21  },
      { name: 'Smart Fragrances', lead_time: 90  },
      { name: 'FIA',              lead_time: 21  },
      { name: 'Scent Method',     lead_time: 21  },
      { name: 'BELL',             lead_time: 90  },
      { name: 'Natarom',          lead_time: 90  },
    ];
    for (const s of knownSuppliers) {
      await pool.query(
        `INSERT INTO suppliers (name, lead_time) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET lead_time = EXCLUDED.lead_time, updated_at = NOW()`,
        [s.name, s.lead_time]
      );
    }

    console.log('✅ Replenishment migration complete');
    res.json({ success: true, message: 'Migration complete: lead_time column added, forecasts + suppliers tables created with default suppliers seeded.' });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/forecast/import — Upload Salesforce Excel forecast
router.post('/forecast/import', upload.single('file'), async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can import forecasts' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { read, utils } = await import('xlsx');
    const workbook = read(req.file.path, { type: 'file' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // ── Parse raw rows (no header auto-detection — file has blank row 1, header on row 2)
    const rawRows = utils.sheet_to_json(sheet, { header: 1, defval: null });

    // Find the actual header row (first row that contains 'productCode' or 'product_code')
    let headerRowIndex = -1;
    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      if (!row) continue;
      const hasProductCol = row.some(cell =>
        cell && String(cell).toLowerCase().replace(/\s/g,'').includes('productcode')
      );
      if (hasProductCol) { headerRowIndex = i; break; }
    }

    if (headerRowIndex === -1) {
      return res.status(400).json({ error: 'Could not find header row. Make sure the file has a "productCode" column.' });
    }

    const headers = rawRows[headerRowIndex].map(h => (h ? String(h).trim() : ''));
    const dataRows = rawRows.slice(headerRowIndex + 1);

    // Find column indexes (flexible matching)
    const productCodeIdx = headers.findIndex(h => h.toLowerCase().replace(/[\s_]/g,'').includes('productcode'));
    const forecastIdx    = headers.findIndex(h => h.toLowerCase().includes('forecast') || h.toLowerCase().includes('demand'));

    if (productCodeIdx === -1 || forecastIdx === -1) {
      return res.status(400).json({
        error: 'Could not find required columns.',
        found: headers,
        expected: ['productCode (or product_code)', 'any column with "forecast" or "demand"']
      });
    }

    const importedBy = req.body.imported_by || 'system';
    const importDate = new Date();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      let inserted = 0, skipped = 0;

      for (const row of dataRows) {
        if (!row || row.every(c => c === null || c === '')) continue; // skip empty rows

        const productCode = row[productCodeIdx] ? String(row[productCodeIdx]).trim() : '';
        const rawForecast = row[forecastIdx];
        // Salesforce forecast is in Litres — store as L (no conversion needed)
        const forecast    = parseFloat(rawForecast) || 0;

        // Skip blank/invalid product codes (e.g. "(blank)" row at end)
        if (!productCode || productCode === '' || productCode.toLowerCase() === '(blank)') {
          skipped++;
          continue;
        }

        await client.query(
          `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by) VALUES ($1, $2, $3, $4)`,
          [productCode, forecast, importDate, importedBy]
        );
        inserted++;
      }

      await client.query('COMMIT');
      try { await fs.unlink(req.file.path); } catch (_) {}

      res.json({ success: true, inserted, skipped, importDate: importDate.toISOString(), importedBy });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Forecast import error:', error);
    try { if (req.file) await fs.unlink(req.file.path); } catch (_) {}
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/forecast/last — Export last forecast as Excel backup
router.get('/forecast/last', async (req, res) => {
  try {
    const lastImport = await pool.query(`SELECT import_date, imported_by FROM forecasts ORDER BY import_date DESC LIMIT 1`);
    if (!lastImport.rows.length) return res.status(404).json({ error: 'No forecast imported yet' });

    const { import_date } = lastImport.rows[0];
    const rows = await pool.query(
      `SELECT product_code, forecast_120_days, import_date, imported_by FROM forecasts
       WHERE DATE_TRUNC('second', import_date) = DATE_TRUNC('second', $1::timestamptz)
       ORDER BY product_code`,
      [import_date]
    );

    const { utils, write } = await import('xlsx');
    const ws = utils.json_to_sheet(rows.rows.map(r => ({
      product_code: r.product_code,
      forecast_120_days: parseFloat(r.forecast_120_days),
      import_date: new Date(r.import_date).toISOString().split('T')[0],
      imported_by: r.imported_by
    })));
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Forecast');
    const buffer = write(wb, { type: 'buffer', bookType: 'xlsx' });
    const dateStr = new Date(import_date).toISOString().split('T')[0];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="forecast_backup_${dateStr}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Forecast export error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/forecast/import-history — List import batches
router.get('/forecast/import-history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC('second', import_date) AS import_date, imported_by, COUNT(*) AS product_count
      FROM forecasts GROUP BY DATE_TRUNC('second', import_date), imported_by
      ORDER BY import_date DESC LIMIT 20
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/suppliers — List all suppliers with their lead times
router.get('/suppliers', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM suppliers ORDER BY name`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/suppliers — Create a new supplier
router.post('/suppliers', async (req, res) => {
  try {
    const { name, lead_time, notes } = req.body;
    if (!name || !lead_time) return res.status(400).json({ error: 'name and lead_time are required' });
    const result = await pool.query(
      `INSERT INTO suppliers (name, lead_time, notes) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET lead_time = EXCLUDED.lead_time, notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING *`,
      [name.trim(), parseInt(lead_time), notes || '']
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/suppliers/:id — Update supplier lead time
router.put('/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, lead_time, notes } = req.body;
    const result = await pool.query(
      `UPDATE suppliers SET
         name      = COALESCE($1, name),
         lead_time = COALESCE($2, lead_time),
         notes     = COALESCE($3, notes),
         updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [name || null, lead_time ? parseInt(lead_time) : null, notes ?? null, parseInt(id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Supplier not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/suppliers/:id — Delete a supplier
router.delete('/suppliers/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM suppliers WHERE id = $1 RETURNING id`, [parseInt(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/products/:id/status — Toggle Active / Inactive
router.patch('/products/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userId } = req.body;
    if (!['active', 'inactive'].includes(status))
      return res.status(400).json({ error: 'status must be "active" or "inactive"' });
    const result = await pool.query(
      `UPDATE products SET status = $1 WHERE id = $2 RETURNING id, name, status, "productCode", category`,
      [status, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    const row = result.rows[0];
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, $2, 'product', $3, $4, $5)`,
      [req.user.id,
       status === 'inactive' ? 'product_deactivated' : 'product_activated',
       row.id, row.name,
       JSON.stringify({ productCode: row.productCode, category: row.category, status })]
    );
    res.json({ success: true, ...row });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/products/:id/lead-time — Override lead_time for a specific product (NULL = use supplier default)
router.put('/products/:id/lead-time', async (req, res) => {
  try {
    const { id } = req.params;
    const { lead_time } = req.body; // pass null to reset to supplier default
    const val = lead_time === null || lead_time === '' ? null : parseInt(lead_time);
    if (val !== null && isNaN(val)) return res.status(400).json({ error: 'lead_time must be a number or null' });
    const result = await pool.query(
      `UPDATE products SET lead_time = $1 WHERE id = $2 RETURNING id, lead_time`,
      [val, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, id: result.rows[0].id, lead_time: result.rows[0].lead_time });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/products/:id/transactions — Daily consumption detail for modal
router.get('/products/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    const result = await pool.query(`
      SELECT
        DATE(created_at::timestamptz AT TIME ZONE 'Australia/Sydney') AS date,
        type,
        SUM(quantity) AS volume_raw,
        COUNT(*) AS transactions
      FROM transactions
      WHERE product_id = $1
        AND type IN ('remove', 'shopify_sale', 'sale')
        AND (created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date >= ((NOW() AT TIME ZONE 'Australia/Sydney') - make_interval(days => $2))::date
      GROUP BY DATE(created_at::timestamptz AT TIME ZONE 'Australia/Sydney'), type
      ORDER BY date ASC
    `, [id, days]);

    // Get product unit to know if we need to convert
    const prodResult = await pool.query(
      'SELECT unit FROM products WHERE id = $1', [id]
    );
    const unit = prodResult.rows[0]?.unit || 'mL';
    const R = unit === 'mL' ? 1000 : 1;

    const dailySales = result.rows.map(r => ({
      date: new Date(r.date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      volume_l: parseFloat((parseFloat(r.volume_raw) / R).toFixed(3)),
      type: r.type === 'shopify_sale' ? 'Shopify' : r.type === 'remove' ? 'Manual' : r.type,
      transactions: parseInt(r.transactions)
    }));

    res.json({ dailySales });
  } catch (error) {
    console.error('Product transactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PRODUCT ALIASES ─────────────────────────────────────────────────────────
router.get('/products/:id/aliases', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, alias_name, created_at FROM product_aliases WHERE product_id = $1 ORDER BY created_at ASC',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get aliases error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/products/:id/aliases', async (req, res) => {
  try {
    const { id } = req.params;
    const { alias_name } = req.body;
    if (!alias_name || !alias_name.trim()) {
      return res.status(400).json({ error: 'Alias name is required' });
    }
    const result = await pool.query(
      'INSERT INTO product_aliases (product_id, alias_name) VALUES ($1, $2) RETURNING id, alias_name, created_at',
      [id, alias_name.trim()]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Add alias error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/products/aliases/:aliasId', async (req, res) => {
  try {
    const { aliasId } = req.params;
    await pool.query('DELETE FROM product_aliases WHERE id = $1', [aliasId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete alias error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/aliases — Global view: all aliases with their linked product
router.get('/aliases', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pa.id,
        pa.alias_name,
        pa.created_at,
        p.id          AS product_id,
        p.name        AS product_name,
        p."productCode" AS product_code,
        p.category
      FROM product_aliases pa
      JOIN products p ON pa.product_id = p.id
      ORDER BY pa.alias_name ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Get all aliases error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/dashboard/replenishment — Main data endpoint (smart demand calculation)
router.get('/dashboard/replenishment', async (req, res) => {
  try {
    // All date calculations use Australian/Sydney timezone directly in SQL

    const [productsResult, salesByDayResult, forecastResult, lastForecastResult, suppliersResult, poResult] = await Promise.all([
      // Products with lead_time resolved: product override → supplier default → 30d fallback
      pool.query(`
        SELECT
          p.id,
          p."productCode",
          p.name,
          p."currentStock",
          p.unit,
          p.supplier,
          p.lead_time AS product_lead_time_override,
          COALESCE(p.lead_time, s.lead_time, 30) AS lead_time,
          p.category,
          p."minStockLevel"
        FROM products p
        LEFT JOIN suppliers s ON (p.supplier_id IS NOT NULL AND s.id = p.supplier_id)
                               OR (p.supplier_id IS NULL AND LOWER(TRIM(p.supplier)) = LOWER(TRIM(s.name)))
        WHERE p.status = 'active'
        ORDER BY p.name
      `),
      // Sales broken down by product AND day — use Australian timezone for correct date grouping
      pool.query(`
        SELECT
          product_id,
          DATE(created_at::timestamptz AT TIME ZONE 'Australia/Sydney') AS sale_date,
          SUM(quantity) AS daily_volume
        FROM transactions
        WHERE type IN ('remove', 'shopify_sale', 'sale')
          AND (created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date >= (NOW() AT TIME ZONE 'Australia/Sydney')::date - INTERVAL '30 days'
        GROUP BY product_id, DATE(created_at::timestamptz AT TIME ZONE 'Australia/Sydney')
        ORDER BY product_id, sale_date
      `),
      // Latest forecast per product
      pool.query(`
        SELECT DISTINCT ON (product_code)
          product_code, forecast_120_days, import_date
        FROM forecasts
        ORDER BY product_code, import_date DESC
      `),
      pool.query(`SELECT import_date, imported_by FROM forecasts ORDER BY import_date DESC LIMIT 1`),
      pool.query(`SELECT id, name, lead_time, notes FROM suppliers ORDER BY name`),
      // Pending purchase orders: quantity still on the way per product
      pool.query(`
        SELECT product_id, SUM(quantity - COALESCE(quantity_received, 0)) AS pending_qty
        FROM purchase_orders
        WHERE status IN ('pending', 'partial')
        GROUP BY product_id
      `)
    ]);

    // ── Build per-product daily sales map { productId -> [{ date, volume }] }
    const dailySalesMap = {};
    for (const row of salesByDayResult.rows) {
      if (!dailySalesMap[row.product_id]) dailySalesMap[row.product_id] = [];
      dailySalesMap[row.product_id].push({ date: row.sale_date, volume: parseFloat(row.daily_volume) || 0 });
    }

    // ── Forecast map
    const forecastMap = {};
    for (const row of forecastResult.rows) {
      forecastMap[row.product_code] = {
        forecast_120_days: parseFloat(row.forecast_120_days) || 0,
        import_date: row.import_date
      };
    }

    // ── Supplier lead-time map
    const supplierMap = {};
    for (const row of suppliersResult.rows) {
      supplierMap[row.name.toLowerCase().trim()] = row.lead_time;
    }

    // ── Pending PO map: productId → pending quantity still on the way
    const poIncomingMap = {};
    for (const row of poResult.rows) {
      poIncomingMap[row.product_id] = parseFloat(row.pending_qty) || 0;
    }

    // ════════════════════════════════════════════════════════════════════════
    // DEMAND PLANNING CALCULATOR — v2
    // Separates two demand streams (Retail vs B2B) and produces 3 scenarios:
    //   Conservative = peak retail + 100% B2B forecast  (buy-safe decision)
    //   Expected     = avg retail  + 100% B2B forecast  (normal planning)
    //   Optimistic   = min retail  + 70%  B2B forecast  (best-case scenario)
    // safetyStatus is driven by the Conservative scenario (worst-case protection).
    // ════════════════════════════════════════════════════════════════════════
    const calcSmartDemand = (dailyEntries, forecastDaily) => {
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
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
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

    // ── Build final product data
    const data = productsResult.rows.map(p => {
      const realStock  = parseFloat(p.currentStock) || 0;
      const leadTime   = Math.max(1, parseInt(p.lead_time) || 30); // never 0 or negative
      const leadTimeSource = p.product_lead_time_override != null
        ? 'product_override'
        : (p.supplier && supplierMap[p.supplier.toLowerCase().trim()] ? 'supplier_default' : 'fallback');

      const fc           = forecastMap[p.productCode] || null;
      // Forecast stored in L (from Salesforce), convert to mL to match stock/transaction units
      const forecast120  = fc ? fc.forecast_120_days * 1000 : null;
      const forecastDaily = forecast120 != null ? forecast120 / 120 : null;

      const dailyEntries = dailySalesMap[p.id] || [];
      const demand = calcSmartDemand(dailyEntries, forecastDaily);

      const avgDailyDemand = demand.avgDailyDemand;
      const { conservative, expected, optimistic } = demand.scenarios;

      // ── Days of stock per scenario
      const todays = (rate) => rate > 0 ? realStock / rate : (realStock > 0 ? 9999 : 0);
      const daysConservative  = todays(conservative);
      const daysExpected      = todays(expected);
      const daysOptimistic    = todays(optimistic);

      // ── backward compat fields
      const projectedDaily       = conservative; // worst-case is the "projected"
      const daysOfStockActual    = daysExpected;
      const projectedDaysOfStock = daysConservative;
      const gap                  = daysConservative - daysExpected;

      // Safety stock = expected × lead time × 1.5
      const safetyStockLevel = expected * leadTime * 1.5;

      // ── Safety Status driven by Conservative scenario (worst-case protection)
      const BUFFER_CRITICAL  = leadTime + 10;
      const BUFFER_ATTENTION = leadTime + 45;

      const safetyStatus = realStock <= 0                ? 'Critical'
        : daysConservative < BUFFER_CRITICAL             ? 'Critical'
        : daysConservative < BUFFER_ATTENTION            ? 'Attention'
        : 'Safe';

      const minStockLevel  = parseFloat(p.minStockLevel) || 0;
      const incomingStock  = poIncomingMap[p.id] || 0;
      const effectiveStock = realStock + incomingStock;

      // ── Suggested Order Quantities
      // ORDER_BUFFER_DAYS dinâmico baseado na variabilidade da demanda (CV).
      // Forecast atualizado mensalmente → tolerância de 35 dias antes de penalidade.
      // CV baixo (demanda estável) → buffer menor; CV alto (volátil) → buffer maior.
      const ORDER_BUFFER_DAYS = demand.dynamicBufferDays || 45;

      // Forecast staleness: penalidade crescente no conservador se forecast > 35 dias.
      // Atualização mensal esperada → após 60d sem update algo está errado.
      const forecastAgeDays = fc
        ? Math.floor((Date.now() - new Date(fc.import_date)) / 86400000)
        : 0;
      const stalenessFactor = forecastAgeDays > 35
        ? Math.min(1.25, 1 + ((forecastAgeDays - 35) / 200))
        : 1.0;
      const conservativeAdjusted = conservative * stalenessFactor;

      // Normal order: based on expected scenario
      const suggestedOrderRaw = expected > 0
        ? Math.max(0, (expected * (leadTime + ORDER_BUFFER_DAYS)) - effectiveStock)
        : 0;
      // Safe order: based on conservative (staleness-adjusted) scenario.
      // minStockLevel is intentionally excluded as a floor here — it is a reorder
      // trigger (used in stock alerts), not an order target. If included, a
      // misconfigured minStockLevel can override the formula and produce absurd
      // quantities (e.g. 179L for a product consuming 5L/month).
      const safeOrderRaw = conservativeAdjusted > 0
        ? Math.max(0, (conservativeAdjusted * (leadTime + ORDER_BUFFER_DAYS)) - effectiveStock)
        : 0;

      // Convert mL → L only for OILS (unit === 'mL')
      // RAW_MATERIALS, MACHINES_SPARES, SCENT_MACHINES use 'units' — no conversion
      const isML = p.unit === 'mL';
      const R = isML ? 1000 : 1;
      const r3 = v => Math.round(v * 1000) / 1000; // round to 3dp
      const r1 = v => Math.round(v * 10) / 10;     // round to 1dp
      const r0 = v => Math.round(v);               // round to integer

      return {
        id:                  p.id,
        productCode:         p.productCode,
        name:                p.name,
        unit:                isML ? 'L' : (p.unit || 'units'),
        realStock:           r1(realStock / R),
        incomingStock:       r1(incomingStock / R),
        safetyStockLevel:    r1(safetyStockLevel / R),
        // ── Demand streams (separated)
        retailDailyAvg:      r3(demand.retailDailyAvg / R),
        retailDailyPeak:     r3(demand.retailDailyPeak / R),
        retailDailyMin:      r3(demand.retailDailyMin / R),
        b2bDaily:            r3(demand.b2bDaily / R),
        // ── 3 Scenarios (daily rate)
        scenarioConservativeRate: r3(conservative / R),
        scenarioExpectedRate:     r3(expected / R),
        scenarioOptimisticRate:   r3(optimistic / R),
        // ── Days of stock per scenario
        daysConservative:    daysConservative >= 9999 ? 9999 : r1(daysConservative),
        daysExpected:        daysExpected     >= 9999 ? 9999 : r1(daysExpected),
        daysOptimistic:      daysOptimistic   >= 9999 ? 9999 : r1(daysOptimistic),
        // ── Order quantities
        suggestedOrder:      r0(suggestedOrderRaw / R),   // based on expected
        safeOrder:           r0(safeOrderRaw / R),        // based on conservative
        // ── Backward compat (StockManagement uses these)
        avgDailyDemand:      r3(avgDailyDemand / R),
        totalSold30d:        r1(demand.totalSold30d / R),
        forecast120Days:     forecast120 != null ? r1(forecast120 / R) : null,
        forecastDaily:       forecastDaily != null ? r3(forecastDaily / R) : null,
        forecastImportDate:  fc ? fc.import_date : null,
        projectedDaily:      r3(projectedDaily / R),
        projectedDaysOfStock: projectedDaysOfStock >= 9999 ? 9999 : r1(projectedDaysOfStock),
        daysOfStockActual:   daysOfStockActual >= 9999 ? 9999 : r1(daysOfStockActual),
        gap:                 r1(gap),
        safetyStatus,
        leadTime,
        leadTimeSource,
        supplier:            p.supplier || '',
        category:            p.category,
        noSalesData:         demand.totalSold30d === 0,
        hasForecast:         fc != null,
        dataConfidence:      demand.dataConfidence,
        cleanDays:           demand.cleanDays,
        spikesRemoved:       demand.spikesRemoved,
        forecastAgeDays,
        trendMultiplier:     Math.round(demand.trendMultiplier * 100) / 100,
        dynamicBufferDays:   demand.dynamicBufferDays
      };
    });

    const statusOrder = { Critical: 0, Attention: 1, Safe: 2 };
    data.sort((a, b) => {
      const diff = statusOrder[a.safetyStatus] - statusOrder[b.safetyStatus];
      return diff !== 0 ? diff : a.projectedDaysOfStock - b.projectedDaysOfStock;
    });

    res.json({
      products: data,
      meta: {
        totalProducts:     data.length,
        critical:          data.filter(d => d.safetyStatus === 'Critical').length,
        attention:         data.filter(d => d.safetyStatus === 'Attention').length,
        safe:              data.filter(d => d.safetyStatus === 'Safe').length,
        lastForecastImport: lastForecastResult.rows[0] || null,
        suppliers:         suppliersResult.rows,
        calculatedAt:      new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Replenishment dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// FRONTEND SERVING — removed (Appendix A step 8). The platform server owns
// static serving and the single SPA catch-all (with the next() guardrail).
// ========================================================================

const uploadsDir = join(__dirname, '../../uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}


// ========================================================================
// PRODUCT RETURNS ENDPOINT
// ========================================================================
router.post('/returns', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { items, notes, returnedBy } = req.body;
    
    // Validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error('No items provided');
    }
    
    if (!returnedBy || !returnedBy.trim()) {
      throw new Error('returnedBy is required');
    }
    
    const processedItems = [];
    
    // Process each return item
    for (const item of items) {
      const { productId, quantity } = item;
      
      if (!productId || !quantity || quantity <= 0) {
        continue; // Skip invalid items
      }
      
      // Get product FOR UPDATE to lock row
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1 FOR UPDATE',
        [productId]
      );
      
      if (productResult.rows.length === 0) {
        console.error(`Product not found: ${productId}`);
        continue; // Skip if product not found
      }
      
      const product = productResult.rows[0];
      const currentStock = parseFloat(product.currentStock) || 0;
      const quantityToAdd = parseFloat(quantity);
      const newStock = currentStock + quantityToAdd;
      
      // Update product stock
      await client.query(
        'UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
        [newStock, Math.floor(newStock / (product.unitPerBox || 1)), productId]
      );
      
      // Create return transaction with notes and returnedBy
      const transactionNotes = notes && notes.trim() 
        ? `Return: ${notes.trim()} | Returned by: ${returnedBy.trim()}`
        : `Product return | Returned by: ${returnedBy.trim()}`;
      
      await client.query(
        `INSERT INTO transactions 
         (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          productId,
          product.productCode || product.tag,
          product.name,
          product.category,
          'return', // New transaction type
          quantityToAdd,
          product.unit,
          newStock,
          transactionNotes
        ]
      );
      
      processedItems.push({
        productId,
        productName: product.name,
        quantityReturned: quantityToAdd,
        newStock,
        unit: product.unit
      });
      
      console.log(`✅ Return processed: ${product.name} +${quantityToAdd} ${product.unit} → ${newStock} ${product.unit}`);
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      processedCount: processedItems.length,
      items: processedItems,
      returnedBy: returnedBy.trim(),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Process returns error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// SA SCENTED PRODUCTS — Container Templates
// ========================================================================
// Helper — query with hard timeout so a stuck query never hangs the endpoint
const queryWithTimeout = (sql, params = [], ms = 6000) => Promise.race([
  pool.query(sql, params),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error(`Query timed out after ${ms}ms`)), ms
  )),
]);

router.get('/scented-containers', async (req, res) => {
  const t0 = Date.now();
  console.log('➡️  GET /api/scented-containers — start');
  try {
    console.log('  · query 1: containers...');
    const containersRes = await queryWithTimeout(
      `SELECT id, name, sku_prefix, volume_ml, notes, price, created_at
       FROM scented_containers ORDER BY name`
    );
    console.log(`  · query 1 done (${Date.now() - t0}ms, ${containersRes.rows.length} rows)`);

    console.log('  · query 2: bom...');
    const bomRes = await queryWithTimeout(
      `SELECT id, container_id, seq, component_code, component_name,
              quantity::float AS quantity, unit, is_fragrance
       FROM scented_container_bom ORDER BY container_id, seq`
    );
    console.log(`  · query 2 done (${Date.now() - t0}ms, ${bomRes.rows.length} rows)`);

    const bomByContainer = {};
    for (const row of bomRes.rows) {
      if (!bomByContainer[row.container_id]) bomByContainer[row.container_id] = [];
      bomByContainer[row.container_id].push(row);
    }
    const out = containersRes.rows.map(c => ({ ...c, bom: bomByContainer[c.id] || [] }));
    console.log(`✅ GET /api/scented-containers → ${out.length} containers (${Date.now() - t0}ms total)`);
    res.json(out);
  } catch (error) {
    console.error(`❌ GET /api/scented-containers FAILED after ${Date.now() - t0}ms:`, error.message, error.code || '');
    res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

router.post('/scented-containers', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage containers' });
  try {
    const { name, sku_prefix, volume_ml, notes, price } = req.body;
    if (!name || !sku_prefix) return res.status(400).json({ error: 'name and sku_prefix are required' });
    const result = await pool.query(
      `INSERT INTO scented_containers (name, sku_prefix, volume_ml, notes, price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), sku_prefix.trim().toUpperCase(), volume_ml || null, notes || null, price || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Container name or SKU prefix already exists' });
    console.error('POST /api/scented-containers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/scented-containers/:id', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage containers' });
  try {
    const { name, volume_ml, notes, price } = req.body;
    const result = await pool.query(
      `UPDATE scented_containers
       SET name = COALESCE($1, name),
           volume_ml = COALESCE($2, volume_ml),
           notes = COALESCE($3, notes),
           price = COALESCE($4, price)
       WHERE id = $5 RETURNING *`,
      [name || null, volume_ml || null, notes || null, price ?? null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Container not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('PUT /api/scented-containers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/scented-containers/:id', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can manage containers' });
  try {
    const result = await pool.query(
      'DELETE FROM scented_containers WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Container not found' });
    res.json({ success: true });
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Cannot delete container — it has been used to create products' });
    console.error('DELETE /api/scented-containers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Container BOM ─────────────────────────────────────────────────────────
router.get('/scented-containers/:id/bom', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM scented_container_bom WHERE container_id = $1 ORDER BY seq',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/scented-containers/:id/bom', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
  try {
    const { component_code, component_name, quantity, unit, is_fragrance } = req.body;
    if (!component_code || !quantity) return res.status(400).json({ error: 'component_code and quantity are required' });

    if (is_fragrance) {
      const existing = await pool.query(
        'SELECT id FROM scented_container_bom WHERE container_id = $1 AND is_fragrance = true',
        [req.params.id]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Container already has a fragrance placeholder row' });
      }
    }

    const seqResult = await pool.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM scented_container_bom WHERE container_id = $1',
      [req.params.id]
    );
    const result = await pool.query(
      `INSERT INTO scented_container_bom (container_id, component_code, component_name, quantity, unit, is_fragrance, seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, component_code.trim(), component_name || null, quantity, unit || 'mL', is_fragrance || false, seqResult.rows[0].next_seq]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Component already exists in this container BOM' });
    console.error('POST container-bom error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/scented-containers/:id/bom/:bomId', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
  try {
    const { component_name, quantity, unit } = req.body;
    const result = await pool.query(
      `UPDATE scented_container_bom
       SET component_name = COALESCE($1, component_name),
           quantity = COALESCE($2, quantity),
           unit = COALESCE($3, unit)
       WHERE id = $4 AND container_id = $5 RETURNING *`,
      [component_name || null, quantity || null, unit || null, req.params.bomId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'BOM row not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/scented-containers/:id/bom/:bomId', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can modify BOM' });
  try {
    const result = await pool.query(
      'DELETE FROM scented_container_bom WHERE id = $1 AND container_id = $2 RETURNING id',
      [req.params.bomId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'BOM row not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================================================
// SA SCENTED PRODUCTS — Product Groups (Lines)
// ========================================================================
router.get('/scented-product-groups', async (req, res) => {
  const t0 = Date.now();
  console.log('➡️  GET /api/scented-product-groups — start');
  try {
    console.log('  · query 1: groups...');
    const groupsRes = await queryWithTimeout(
      `SELECT id, group_name, fragrance_product_id, created_by, created_at
       FROM scented_product_groups ORDER BY created_at DESC`
    );
    console.log(`  · query 1 done (${Date.now() - t0}ms, ${groupsRes.rows.length} rows)`);
    const groups = groupsRes.rows;
    if (groups.length === 0) {
      console.log(`✅ GET /api/scented-product-groups → 0 groups (${Date.now() - t0}ms)`);
      return res.json([]);
    }

    const groupIds      = groups.map(g => g.id);
    const fragranceIds  = [...new Set(groups.map(g => g.fragrance_product_id).filter(Boolean))];

    console.log(`  · query 2/3: products (${groupIds.length} groups, ${fragranceIds.length} fragrances)...`);
    const [productsRes, fragranceRes] = await Promise.all([
      queryWithTimeout(
        `SELECT id, "productCode", name, "currentStock", unit, "minStockLevel", status, "shopifySkus", group_id
         FROM products WHERE group_id = ANY($1::int[]) ORDER BY "productCode"`,
        [groupIds]
      ),
      fragranceIds.length > 0
        ? queryWithTimeout(
            `SELECT id, "productCode", name, "currentStock", unit
             FROM products WHERE id = ANY($1::text[])`,
            [fragranceIds]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    console.log(`  · queries 2/3 done (${Date.now() - t0}ms)`);

    const productsByGroup = {};
    for (const p of productsRes.rows) {
      if (!productsByGroup[p.group_id]) productsByGroup[p.group_id] = [];
      productsByGroup[p.group_id].push(p);
    }
    const fragranceById = {};
    for (const f of fragranceRes.rows) fragranceById[f.id] = f;

    const out = groups.map(g => {
      const f = g.fragrance_product_id ? fragranceById[g.fragrance_product_id] : null;
      return {
        ...g,
        fragrance_code:   f ? f.productCode   : null,
        fragrance_name:   f ? f.name          : null,
        fragrance_stock:  f ? f.currentStock  : null,
        fragrance_unit:   f ? f.unit          : null,
        products:         productsByGroup[g.id] || [],
      };
    });
    console.log(`✅ GET /api/scented-product-groups → ${out.length} groups (${Date.now() - t0}ms total)`);
    res.json(out);
  } catch (error) {
    console.error(`❌ GET /api/scented-product-groups FAILED after ${Date.now() - t0}ms:`, error.message, error.code || '');
    res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

router.post('/scented-product-groups', async (req, res) => {
  if (!['admin', 'root'].includes(req.user.role)) return res.status(403).json({ error: 'Only admin or root can create scented product lines' });
  const client = await pool.connect();
  try {
    const {
      group_name, fragrance_product_id, container_ids,
      fragrance_description, fragrance_type, fragrance_notes,
    } = req.body;
    if (!group_name || !Array.isArray(container_ids) || container_ids.length === 0) {
      return res.status(400).json({ error: 'group_name and container_ids[] are required' });
    }

    await client.query('BEGIN');

    // 1. Create group
    const groupResult = await client.query(
      `INSERT INTO scented_product_groups
         (group_name, fragrance_product_id, created_by,
          fragrance_description, fragrance_type, fragrance_notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        group_name.trim(), fragrance_product_id || null, req.user.id,
        fragrance_description?.trim() || null,
        fragrance_type?.trim()        || null,
        fragrance_notes?.trim()       || null,
      ]
    );
    const group = groupResult.rows[0];

    // Resolve fragrance productCode for BOM substitution
    let fragranceCode = null;
    let fragranceName = null;
    if (fragrance_product_id) {
      const fp = await client.query(
        `SELECT "productCode", name FROM products WHERE id = $1`,
        [fragrance_product_id]
      );
      if (fp.rows.length > 0) {
        fragranceCode = fp.rows[0].productCode;
        fragranceName = fp.rows[0].name;
      }
    }

    // Next internal product ID base
    const maxIdResult = await client.query(
      `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^.*_', '') AS INTEGER)), 0) AS max_num
       FROM products WHERE id LIKE 'SA_SCENTED_PRODUCTS_%'`
    );
    let nextIdNum = parseInt(maxIdResult.rows[0].max_num) + 1;

    // Next tag (#SP00001) — global counter across ALL products with #SP tag
    // so we never collide with existing tags (even from deleted-and-recreated rows)
    const maxTagResult = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(tag FROM 4) AS INTEGER)), 0) AS max_tag
       FROM products WHERE tag ~ '^#SP[0-9]+$'`
    );
    let nextTagNum = parseInt(maxTagResult.rows[0].max_tag) + 1;

    const createdProducts = [];

    // 2. Create one product per container
    for (const containerId of container_ids) {
      const cRes = await client.query('SELECT * FROM scented_containers WHERE id = $1', [containerId]);
      if (cRes.rows.length === 0) throw new Error(`Container ${containerId} not found`);
      const container = cRes.rows[0];

      const skuNum   = await nextScentedSkuNum(client, container.sku_prefix);
      const padded   = String(skuNum).padStart(5, '0');
      const sku      = `${container.sku_prefix}_${padded}`;
      const prodId   = `SA_SCENTED_PRODUCTS_${nextIdNum}`;
      const tag      = `#SP${String(nextTagNum).padStart(5, '0')}`;
      nextTagNum++;
      const prodName = `${group_name.trim()} - ${container.name}`;

      const pRes = await client.query(
        `INSERT INTO products
         (id, tag, "productCode", name, category, unit, "currentStock", "minStockLevel",
          "shopifySkus", "skuMultipliers", supplier, "supplier_code", "unitPerBox", "stockBoxes",
          "incoming_orders", group_id)
         VALUES ($1,$2,$3,$4,'SA_SCENTED_PRODUCTS','units',0,0,$5,'{}','','',1,0,'[]',$6)
         RETURNING *`,
        [prodId, tag, sku, prodName, JSON.stringify({ [container.sku_prefix]: sku }), group.id]
      );
      const product = pRes.rows[0];

      // Copy BOM template → bom table (replace is_fragrance placeholder with real oil)
      const bomRows = await client.query(
        'SELECT * FROM scented_container_bom WHERE container_id = $1 ORDER BY seq',
        [containerId]
      );
      for (const row of bomRows.rows) {
        const compCode = row.is_fragrance && fragranceCode ? fragranceCode : row.component_code;
        const compName = row.is_fragrance && fragranceName ? fragranceName : (row.component_name || compCode);
        await client.query(
          `INSERT INTO bom (variant, seq, component_code, component_name, quantity, unit)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (variant, component_code) DO NOTHING`,
          [sku, row.seq, compCode, compName, row.quantity, row.unit]
        );
      }

      createdProducts.push(product);
      nextIdNum++;
    }

    // 3. Audit log
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1,'scented_group_created','scented_product_group',$2,$3,$4)`,
      [req.user.id, String(group.id), group.group_name,
       JSON.stringify({ products: createdProducts.map(p => p.productCode) })]
    );

    await client.query('COMMIT');
    res.json({ success: true, group, products: createdProducts });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('POST /api/scented-product-groups error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

// Dashboard widget data for SA Scented Products
router.get('/scented-dashboard', async (req, res) => {
  console.log('➡️  GET /api/scented-dashboard — start');
  try {
    const [groupsCount, productsAgg, lowStock, topSold] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM scented_product_groups`),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE "currentStock" <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (WHERE "currentStock" > 0 AND "currentStock" <= "minStockLevel")::int AS low_stock
        FROM products WHERE category = 'SA_SCENTED_PRODUCTS' AND COALESCE(status, 'active') = 'active'
      `),
      pool.query(`
        SELECT id, "productCode", name, "currentStock", "minStockLevel", unit
        FROM products
        WHERE category = 'SA_SCENTED_PRODUCTS'
          AND COALESCE(status, 'active') = 'active'
          AND ("currentStock" <= 0 OR "currentStock" <= "minStockLevel")
        ORDER BY "currentStock" ASC
        LIMIT 10
      `),
      pool.query(`
        SELECT
          p.id, p."productCode", p.name,
          SUM(CASE WHEN t.type = 'shopify_sale' THEN t.quantity ELSE -t.quantity END)::numeric AS sold_qty
        FROM transactions t
        JOIN products p ON p.id = t.product_id
        WHERE p.category = 'SA_SCENTED_PRODUCTS'
          AND t.type IN ('shopify_sale', 'shopify_reversal')
          AND t.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY p.id, p."productCode", p.name
        HAVING SUM(CASE WHEN t.type = 'shopify_sale' THEN t.quantity ELSE -t.quantity END) > 0
        ORDER BY sold_qty DESC
        LIMIT 5
      `),
    ]);

    res.json({
      groups:       groupsCount.rows[0].total,
      products:     productsAgg.rows[0].total,
      outOfStock:   productsAgg.rows[0].out_of_stock,
      lowStock:     productsAgg.rows[0].low_stock,
      lowStockList: lowStock.rows.map(r => ({
        id:           r.id,
        productCode:  r.productCode,
        name:         r.name,
        currentStock: parseFloat(r.currentStock),
        minStockLevel:parseFloat(r.minStockLevel),
        unit:         r.unit,
      })),
      topSold: topSold.rows.map(r => ({
        id:          r.id,
        productCode: r.productCode,
        name:        r.name,
        soldQty:     parseFloat(r.sold_qty),
      })),
    });
    console.log('✅ GET /api/scented-dashboard done');
  } catch (error) {
    console.error('❌ GET /api/scented-dashboard error:', error.message, error.code || '');
    res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

router.delete('/scented-product-groups/:id', async (req, res) => {
  if (!['admin', 'root'].includes(req.user.role)) return res.status(403).json({ error: 'Only admin or root can delete scented product lines' });
  const cascadeProducts = req.query.cascade === 'true';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (cascadeProducts) {
      // Hard delete: remove products + their BOM + transactions tied to them
      const prodIds = await client.query(
        `SELECT id, "productCode" FROM products WHERE group_id = $1`,
        [req.params.id]
      );
      for (const p of prodIds.rows) {
        await client.query(`DELETE FROM bom WHERE variant = $1`, [p.productCode]);
        await client.query(`DELETE FROM transactions WHERE product_id = $1`, [p.id]);
        await client.query(`DELETE FROM products WHERE id = $1`, [p.id]);
      }
    } else {
      // Soft delete: keep products, just detach from group (preserves stock history)
      await client.query(
        `UPDATE products SET group_id = NULL WHERE group_id = $1`,
        [req.params.id]
      );
    }

    const result = await client.query(
      'DELETE FROM scented_product_groups WHERE id = $1 RETURNING group_name',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Group not found' });
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1,'scented_group_deleted','scented_product_group',$2,$3,'{}')`,
      [req.user.id, req.params.id, result.rows[0].group_name]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/scented-product-groups error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ========================================================================
// CLEANUP JOB — Limpeza automática do webhook_processed (roda 1x por dia)
// Mantém só os últimos 30 dias — evita crescimento infinito da tabela
// ========================================================================
const runCleanup = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM webhook_processed
      WHERE processed_at < NOW() - INTERVAL '30 days'
    `);
    if (result.rowCount > 0) {
      console.log(`🧹 Cleanup: removed ${result.rowCount} old webhook_processed records`);
    }
  } catch (err) {
    console.error('⚠️ Cleanup job error:', err.message);
  }
};

// Roda uma vez na inicialização do servidor
runCleanup();

// Roda todo dia às 03:00 AM Sydney time (intervalo de 24h)
setInterval(() => {
  const sydneyHour = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' })
  ).getHours();
  if (sydneyHour === 3) runCleanup();
}, 60 * 60 * 1000); // Checa a cada 1 hora

// ========================================================================
// ERROR HANDLER — router-scoped (was app-level); 4-arg signature required
// ========================================================================
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('💥 Unhandled route error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Run replenishment migration once at startup (idempotent — safe to run every deploy)
async function runStartupMigrations() {
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time INTEGER DEFAULT NULL`);
    await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS estimated_delivery_date DATE DEFAULT NULL`);
    // Schema must match /api/migrate-replenishment and the replenishment dashboard queries.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS forecasts (
        id                SERIAL PRIMARY KEY,
        product_code      TEXT NOT NULL,
        forecast_120_days NUMERIC(12,2) NOT NULL DEFAULT 0,
        import_date       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        imported_by       TEXT NOT NULL DEFAULT 'system'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_forecasts_product_code ON forecasts(product_code)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_forecasts_import_date ON forecasts(import_date DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        lead_time   INTEGER DEFAULT 30,
        contact     TEXT,
        notes       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    const knownSuppliers = [
      { name: 'Firmenich',          lead_time: 60  },
      { name: 'Givaudan',           lead_time: 60  },
      { name: 'IFF',                lead_time: 45  },
      { name: 'Symrise',            lead_time: 60  },
      { name: 'Takasago',           lead_time: 75  },
      { name: 'Sensient',           lead_time: 30  },
      { name: 'Natarom',            lead_time: 90  },
    ];
    for (const s of knownSuppliers) {
      await pool.query(
        `INSERT INTO suppliers (name, lead_time) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET lead_time = EXCLUDED.lead_time, updated_at = NOW()`,
        [s.name, s.lead_time]
      );
    }
    // Migrate existing incoming_orders JSONB → purchase_orders table (runs only if PO table is empty)
    await pool.query(`
      INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, notes, added_at, added_by)
      SELECT
        p.id,
        COALESCE(po_item->>'orderNumber', 'MIGRATED'),
        COALESCE((po_item->>'quantity')::numeric, 0),
        po_item->>'supplier',
        po_item->>'notes',
        COALESCE((po_item->>'addedAt')::timestamptz, NOW()),
        COALESCE(po_item->>'addedBy', 'migrated')
      FROM products p, jsonb_array_elements(p.incoming_orders) AS po_item
      WHERE p.incoming_orders IS NOT NULL
        AND p.incoming_orders != '[]'::jsonb
        AND jsonb_typeof(p.incoming_orders) = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM purchase_orders po2
          WHERE po2.product_id = p.id
            AND po2.order_number = COALESCE(po_item->>'orderNumber', 'MIGRATED')
            AND po2.added_by = COALESCE(po_item->>'addedBy', 'migrated')
        )
    `);
    console.log('✅ incoming_orders JSONB migrated to purchase_orders table (idempotent)');

    // ── Webhook queue table ───────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_queue (
        id            SERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        topic         TEXT NOT NULL,
        payload       JSONB NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        queued_at     TIMESTAMPTZ DEFAULT NOW(),
        completed_at  TIMESTAMPTZ,
        error_msg     TEXT
      )
    `);

    // ── Detect webhooks lost to a server crash (pending > 5 min old) ────────
    const lost = await pool.query(`
      SELECT id, idempotency_key, topic, payload
      FROM webhook_queue
      WHERE status IN ('pending','processing')
        AND queued_at < NOW() - INTERVAL '5 minutes'
    `);
    if (lost.rows.length > 0) {
      console.warn(`⚠️  Found ${lost.rows.length} lost webhook(s) — checking if stock was debited...`);
      for (const item of lost.rows) {
        // For fulfillments/create, extract base order name from payload (e.g. "#34314.1" → "#34314")
        // For orders/fulfilled, idempotency_key is already the base order name
        let baseOrder;
        if (item.idempotency_key.startsWith('fulfillment_')) {
          try {
            const p = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;
            const rawName = p.name || '';
            baseOrder = rawName.split('.')[0] || null;
          } catch {
            baseOrder = null;
          }
        } else {
          baseOrder = item.idempotency_key;
        }
        // Check if transactions exist for this order
        const txCheck = await pool.query(
          `SELECT 1 FROM transactions WHERE shopify_order_id = $1 AND type = 'shopify_sale' LIMIT 1`,
          [baseOrder || item.idempotency_key]
        );
        if (txCheck.rows.length > 0) {
          // Stock was actually debited before crash — mark completed
          await pool.query(
            `UPDATE webhook_queue SET status = 'completed', completed_at = NOW(), error_msg = 'recovered_at_startup' WHERE id = $1`,
            [item.id]
          );
          console.log(`  ✅ ${item.idempotency_key} — stock was debited, marked completed`);
        } else {
          // Stock was NOT debited — mark as failed for manual review
          await pool.query(
            `UPDATE webhook_queue SET status = 'failed', error_msg = 'server_crashed_before_commit' WHERE id = $1`,
            [item.id]
          );
          console.error(`  ❌ LOST WEBHOOK: ${item.idempotency_key} (${item.topic}) — stock was NOT debited. Manual review required.`);
        }
      }
    }

    // ── SKU multipliers for multi-variant products (e.g. batteries small/large box) ──
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS "skuMultipliers" JSONB DEFAULT '{}'`);

    // ── Audit log for SKUs skipped during webhook processing ──────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_skipped (
        id              SERIAL PRIMARY KEY,
        shopify_order   TEXT NOT NULL,
        sku             TEXT,
        product_name    TEXT,
        quantity        INTEGER,
        reason          TEXT NOT NULL,
        topic           TEXT,
        skipped_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Ready stock for formulas ──────────────────────────────────────────
    await pool.query(`ALTER TABLE formulas ADD COLUMN IF NOT EXISTS ready_stock_ml NUMERIC DEFAULT 0`);

    // ── Performance indexes ───────────────────────────────────────────────
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_shopify_order_id ON transactions(shopify_order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_product_id_created_at ON transactions(product_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bom_variant_seq ON bom(variant, seq)`);

    // ── SA Scented Products ───────────────────────────────────────────────
    await pool.query(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'mL'`);

    // Remove duplicates in bom — keep the lowest id per (variant, component_code).
    // Earlier versions of the scented-product creation route could insert the same row multiple times.
    await pool.query(`
      DELETE FROM bom a
      USING bom b
      WHERE a.id > b.id
        AND a.variant = b.variant
        AND a.component_code = b.component_code
    `);

    // Add UNIQUE constraint to prevent future duplicates. Idempotent guard.
    await pool.query(`
      DO $bom_unique$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'bom_variant_component_unique'
        ) THEN
          ALTER TABLE bom ADD CONSTRAINT bom_variant_component_unique UNIQUE (variant, component_code);
        END IF;
      END
      $bom_unique$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scented_product_groups (
        id                   SERIAL PRIMARY KEY,
        group_name           TEXT NOT NULL,
        fragrance_product_id TEXT,
        created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Safety: if table was created earlier with fragrance_product_id INTEGER (old schema),
    // alter it to TEXT. Idempotent: only runs when the column type is still integer.
    await pool.query(`
      DO $mig$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'scented_product_groups'
            AND column_name = 'fragrance_product_id'
            AND data_type = 'integer'
        ) THEN
          ALTER TABLE scented_product_groups
          ALTER COLUMN fragrance_product_id TYPE TEXT USING fragrance_product_id::TEXT;
        END IF;
      END
      $mig$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scented_containers (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        sku_prefix TEXT NOT NULL UNIQUE,
        volume_ml  NUMERIC(10,3),
        notes      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scented_container_bom (
        id             SERIAL PRIMARY KEY,
        container_id   INTEGER NOT NULL REFERENCES scented_containers(id) ON DELETE CASCADE,
        component_code TEXT NOT NULL,
        component_name TEXT,
        quantity       NUMERIC(10,3) NOT NULL,
        unit           TEXT NOT NULL DEFAULT 'mL',
        is_fragrance   BOOLEAN NOT NULL DEFAULT false,
        seq            INTEGER NOT NULL DEFAULT 0,
        UNIQUE(container_id, component_code)
      )
    `);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES scented_product_groups(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_group_id ON products(group_id)`);

    // Fragrance metadata for Shopify body_html
    await pool.query(`ALTER TABLE scented_product_groups ADD COLUMN IF NOT EXISTS fragrance_description TEXT`);
    await pool.query(`ALTER TABLE scented_product_groups ADD COLUMN IF NOT EXISTS fragrance_type TEXT`);
    await pool.query(`ALTER TABLE scented_product_groups ADD COLUMN IF NOT EXISTS fragrance_notes TEXT`);

    // Per-container retail price (used by Shopify publish for SA_SCENTED_PRODUCTS)
    await pool.query(`ALTER TABLE scented_containers ADD COLUMN IF NOT EXISTS price NUMERIC(10,2)`);
    console.log('✅ SA Scented Products migrations complete');

    // ── Tech Stock — widen transactions.type column (VARCHAR(20) → VARCHAR(30)) ──
    // 'tech_return_from_tech' is 21 chars and exceeded the original limit.
    await pool.query(`ALTER TABLE transactions ALTER COLUMN type TYPE VARCHAR(30)`);

    // ── Tech Stock — extend transactions type CHECK constraint ────────────
    // The original constraint only covers legacy types. Drop and recreate to
    // include the 5 new tech types. DO $$ block is idempotent (constraint may
    // already be updated on a re-deploy).
    await pool.query(`
      DO $$
      BEGIN
        ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
        ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
          CHECK (type IN (
            'add', 'remove', 'adjust', 'incoming', 'return',
            'shopify_sale', 'shopify_reversal',
            'formula_ready_used', 'formula_ready_restored',
            'tech_transfer_out', 'tech_transfer_in',
            'tech_remove',
            'tech_return_from_tech', 'tech_return_to_main',
            'tech_return_input'
          ));
      END$$;
    `);

    // ── Tech Stock ─────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tech_stock (
        id         SERIAL PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity   NUMERIC(12,3) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tech_stock_product ON tech_stock(product_id)`);
    await pool.query(`ALTER TABLE tech_stock ADD COLUMN IF NOT EXISTS target_quantity NUMERIC(12,3)`);
    await pool.query(`ALTER TABLE tech_stock ADD COLUMN IF NOT EXISTS is_tech_active BOOLEAN NOT NULL DEFAULT false`);
    console.log('✅ Tech Stock migration complete');

    console.log('✅ Replenishment migration complete');
  } catch (err) {
    console.error('⚠️  Replenishment migration error (non-fatal):', err.message);
  }
}

// ========================================================================
// TECH STOCK ROUTES
// ========================================================================
const TECH_ROLES = ['technician', 'admin', 'root'];

// GET /api/tech-stock — list all OILS with main stock + tech stock + total
router.get('/tech-stock', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p."productCode",
        p.name,
        p.category,
        p."currentStock",
        p.unit,
        p."minStockLevel",
        COALESCE(ts.quantity, 0)       AS tech_quantity,
        ts.target_quantity,
        COALESCE(ts.is_tech_active, false) AS is_tech_active
      FROM products p
      LEFT JOIN tech_stock ts ON ts.product_id = p.id
      WHERE p.category = 'OILS'
        AND (p.status IS NULL OR p.status = 'active')
      ORDER BY p.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/tech-stock error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tech-stock/transfer — move qty from main stock to tech stock (atomic)
router.post('/tech-stock/transfer', async (req, res) => {
  if (!TECH_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorised' });
  }
  const { productId, quantity, notes } = req.body;
  const qty = parseFloat(quantity);
  if (!productId || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock product row
    const pRes = await client.query(
      `SELECT id, "productCode", name, "currentStock", unit FROM products WHERE id = $1 AND category = 'OILS' FOR UPDATE`,
      [productId]
    );
    if (pRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or not an OIL' });
    }
    const product = pRes.rows[0];
    const mainStock = parseFloat(product.currentStock);

    if (qty > mainStock) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient main stock. Available: ${mainStock} ${product.unit}` });
    }

    // Debit main stock
    const newMain = mainStock - qty;
    await client.query(
      `UPDATE products SET "currentStock" = $1 WHERE id = $2`,
      [newMain, productId]
    );

    // Credit tech stock (upsert)
    const tsRes = await client.query(
      `INSERT INTO tech_stock (product_id, quantity, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET quantity = tech_stock.quantity + $2, updated_at = NOW()
       RETURNING quantity`,
      [productId, qty]
    );
    const newTech = parseFloat(tsRes.rows[0].quantity);

    // Transactions: one out (main), one in (tech)
    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_transfer_out', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newMain, notes || null]
    );
    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_transfer_in', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newTech, notes || null]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'tech_transfer', 'product', $2, $3, $4)`,
      [req.user.id, productId, product.name, JSON.stringify({ quantity: qty, unit: product.unit, notes: notes || null })]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      mainStock: newMain,
      techStock: newTech,
      product: product.name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tech-stock/transfer error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/tech-stock/remove — consume qty from tech stock (used in service)
router.post('/tech-stock/remove', async (req, res) => {
  if (!TECH_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorised' });
  }
  const { productId, quantity, notes } = req.body;
  const qty = parseFloat(quantity);
  if (!productId || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pRes = await client.query(
      `SELECT p.id, p."productCode", p.name, p.unit, COALESCE(ts.quantity, 0) AS tech_qty
       FROM products p
       LEFT JOIN tech_stock ts ON ts.product_id = p.id
       WHERE p.id = $1 AND p.category = 'OILS'
       FOR UPDATE OF p`,
      [productId]
    );
    if (pRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or not an OIL' });
    }
    const product = pRes.rows[0];
    const techQty = parseFloat(product.tech_qty);

    if (qty > techQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient tech stock. Available: ${techQty} ${product.unit}` });
    }

    const newTech = techQty - qty;
    await client.query(
      `UPDATE tech_stock SET quantity = $1, updated_at = NOW() WHERE product_id = $2`,
      [newTech, productId]
    );

    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_remove', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newTech, notes || null]
    );

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'tech_remove', 'product', $2, $3, $4)`,
      [req.user.id, productId, product.name, JSON.stringify({ quantity: qty, unit: product.unit, notes: notes || null })]
    );

    await client.query('COMMIT');
    res.json({ success: true, techStock: newTech, product: product.name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tech-stock/remove error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/tech-stock/return — return qty from tech back to main stock
router.post('/tech-stock/return', async (req, res) => {
  if (!TECH_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorised' });
  }
  const { productId, quantity, notes } = req.body;
  const qty = parseFloat(quantity);
  if (!productId || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pRes = await client.query(
      `SELECT p.id, p."productCode", p.name, p."currentStock", p.unit, COALESCE(ts.quantity, 0) AS tech_qty
       FROM products p
       LEFT JOIN tech_stock ts ON ts.product_id = p.id
       WHERE p.id = $1 AND p.category = 'OILS'
       FOR UPDATE OF p`,
      [productId]
    );
    if (pRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found or not an OIL' });
    }
    const product = pRes.rows[0];
    const techQty = parseFloat(product.tech_qty);
    const mainStock = parseFloat(product.currentStock);

    if (qty > techQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient tech stock. Available: ${techQty} ${product.unit}` });
    }

    const newTech = techQty - qty;
    const newMain = mainStock + qty;

    await client.query(
      `UPDATE tech_stock SET quantity = $1, updated_at = NOW() WHERE product_id = $2`,
      [newTech, productId]
    );
    await client.query(
      `UPDATE products SET "currentStock" = $1 WHERE id = $2`,
      [newMain, productId]
    );

    // Transactions: out from tech, in to main
    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_return_from_tech', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newTech, notes || null]
    );
    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_return_to_main', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newMain, notes || null]
    );

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'tech_return', 'product', $2, $3, $4)`,
      [req.user.id, productId, product.name, JSON.stringify({ quantity: qty, unit: product.unit, notes: notes || null })]
    );

    await client.query('COMMIT');
    res.json({ success: true, mainStock: newMain, techStock: newTech, product: product.name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tech-stock/return error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/tech-stock/return-input — technician returns oil directly to tech stock
router.post('/tech-stock/return-input', async (req, res) => {
  if (!TECH_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Not authorised' });
  const { productId, quantity, notes } = req.body;
  const qty = parseFloat(quantity);
  if (!productId || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pRes = await client.query(
      `SELECT p.id, p."productCode", p.name, p.unit FROM products p
       WHERE p.id = $1 AND p.category = 'OILS' FOR UPDATE`,
      [productId]
    );
    if (pRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
    const product = pRes.rows[0];

    const tsRes = await client.query(
      `INSERT INTO tech_stock (product_id, quantity, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET quantity = tech_stock.quantity + $2, updated_at = NOW()
       RETURNING quantity`,
      [productId, qty]
    );
    const newTech = parseFloat(tsRes.rows[0].quantity);

    await client.query(
      `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
       VALUES ($1, $2, $3, 'OILS', 'tech_return_input', $4, $5, $6, $7)`,
      [productId, product.productCode, product.name, qty, product.unit, newTech, notes || null]
    );
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'tech_return', 'product', $2, $3, $4)`,
      [req.user.id, productId, product.name, JSON.stringify({ quantity: qty, unit: product.unit, source: 'technician_return', notes: notes || null })]
    );
    await client.query('COMMIT');
    res.json({ success: true, techStock: newTech, product: product.name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tech-stock/return-input error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PUT /api/tech-stock/:productId/config — root sets target_quantity and/or is_tech_active
router.put('/tech-stock/:productId/config', async (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'Only root can configure tech stock' });
  const { productId } = req.params;
  const { target_quantity, is_tech_active } = req.body;

  try {
    // Upsert: create tech_stock row if it doesn't exist yet
    await pool.query(
      `INSERT INTO tech_stock (product_id, quantity, target_quantity, is_tech_active, updated_at)
       VALUES ($1, 0, $2, COALESCE($3, false), NOW())
       ON CONFLICT (product_id) DO UPDATE
         SET target_quantity = COALESCE($2, tech_stock.target_quantity),
             is_tech_active  = COALESCE($3, tech_stock.is_tech_active),
             updated_at      = NOW()`,
      [productId, target_quantity ?? null, is_tech_active ?? null]
    );
    const result = await pool.query(
      `SELECT quantity, target_quantity, is_tech_active FROM tech_stock WHERE product_id = $1`,
      [productId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/tech-stock/:productId/config error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Keep Neon alive during business hours (7am–4pm Melbourne time) ──────────
setInterval(async () => {
  try {
    const hour = parseInt(new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', hour12: false }));
    if (hour >= 7 && hour < 16) {
      await pool.query('SELECT 1');
    }
  } catch (e) { /* silencioso */ }
}, 4 * 60 * 1000);

// ========================================================================
// EXPORTS (Appendix A step 3/6) — app.listen removed; the platform server
// mounts the router at /api/sa and calls runSaStartupMigrations at boot.
// ========================================================================
export { router, runStartupMigrations as runSaStartupMigrations };
