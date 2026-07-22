import { useState, useEffect } from 'react';
import { SA_SKU_KEYS, skuSizeLabel } from '../../../shared/sa-sku-variants.js';
import { GlowingEffect } from '../components/GlowingEffect';
import { useToast } from '../components/Toast';

export default function SkuMapping({ user }) {
  const showToast = useToast();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [shopifyStatusFilter, setShopifyStatusFilter] = useState('ALL');
  const [shopifyStatuses, setShopifyStatuses] = useState({});
  const [shopifyEnabled, setShopifyEnabled] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [publishing, setPublishing] = useState({}); // { [productId]: true }

  useEffect(() => {
    fetchProducts();
    fetchShopifyStatuses();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchShopifyStatuses = async () => {
    setStatusLoading(true);
    try {
      const res = await fetch('/api/shopify/status');
      const data = await res.json();
      setShopifyEnabled(data.enabled);
      setShopifyStatuses(data.statuses || {});
    } catch (error) {
      console.error('Shopify status error:', error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handlePublish = async (product) => {
    setPublishing(prev => ({ ...prev, [product.productId]: true }));
    try {
      const res = await fetch(`/api/shopify/publish/${product.productId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Publish failed');
      const msg = data.failed > 0
        ? `Published ${data.added} product(s) for "${product.productName}". ${data.failed} failed.`
        : `"${product.productName}" published as ${data.added} separate draft product(s) in Shopify!`;
      showToast(msg, 'success');
      await fetchShopifyStatuses();
    } catch (err) {
      showToast(`Publish failed: ${err.message}`, 'error');
    } finally {
      setPublishing(prev => ({ ...prev, [product.productId]: false }));
    }
  };

  const handleAddMissingVariants = async (product) => {
    setPublishing(prev => ({ ...prev, [`missing_${product.productId}`]: true }));
    try {
      const res = await fetch(`/api/shopify/add-missing-variants/${product.productId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      const msg = data.failed > 0
        ? `Added ${data.added} product(s). ${data.failed} failed: ${(data.failedProducts || []).map(f => f.sku).join(', ')}`
        : `Added ${data.added} missing product(s) to Shopify!`;
      showToast(msg, data.failed > 0 ? 'warning' : 'success');
      await fetchShopifyStatuses();
    } catch (err) {
      showToast(`Add variants failed: ${err.message}`, 'error');
    } finally {
      setPublishing(prev => ({ ...prev, [`missing_${product.productId}`]: false }));
    }
  };

  const getShopifyStatusBadge = (sku) => {
    if (!shopifyEnabled) return null;
    const s = shopifyStatuses[sku];
    if (!s) return null;
    const cfg = {
      active:   { label: 'Active',   color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)' },
      draft:    { label: 'Draft',    color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
      archived: { label: 'Archived', color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.3)' },
    };
    const c = cfg[s.status] || cfg.draft;
    return (
      <span style={{
        fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '12px',
        color: c.color, background: c.bg, border: `1px solid ${c.border}`,
        display: 'inline-block'
      }}>
        {c.label}
      </span>
    );
  };

  // Sizes derived from shared/sa-sku-variants.js (QA #16) — was a 4th copy.
  const SKU_SIZES = Object.fromEntries(SA_SKU_KEYS.map(k => [k, skuSizeLabel(k)]));

  const getCategoryLabel = (category) => {
    const labels = {
      OILS: 'Oils',
      SCENT_MACHINES: 'Diffuser Machines',
      MACHINES_SPARES: 'Spares',
      RAW_MATERIALS: 'Raw Materials'
    };
    return labels[category] || category;
  };

  // Generate SKU mappings from products
  const generateMappings = () => {
    const mappings = [];

    products.forEach(product => {
      if (!product.shopifySkus) return;

      if (product.category === 'OILS' && typeof product.shopifySkus === 'object') {
        Object.entries(product.shopifySkus).forEach(([variant, sku]) => {
          if (!sku) return;
          mappings.push({
            id: `${product.id}_${variant}`,
            shopifySku: sku,
            variant,
            productCode: product.productCode,
            productName: product.name,
            category: product.category,
            unit: product.unit,
            productId: product.id,
            productObj: product,
            isFirstVariant: Object.keys(product.shopifySkus)[0] === variant
          });
        });
      } else if (product.category === 'SCENT_MACHINES') {
        const sku = typeof product.shopifySkus === 'string'
          ? product.shopifySkus
          : (Object.values(product.shopifySkus)[0] || product.productCode);
        if (!sku) return;
        mappings.push({
          id: `${product.id}_machine`,
          shopifySku: sku,
          variant: 'Machine',
          productCode: product.productCode,
          productName: product.name,
          category: product.category,
          unit: product.unit,
          productId: product.id,
          productObj: product,
          isFirstVariant: true
        });
      } else if (typeof product.shopifySkus === 'object') {
        Object.entries(product.shopifySkus).forEach(([variant, sku]) => {
          if (!sku) return;
          mappings.push({
            id: `${product.id}_${variant}`,
            shopifySku: sku,
            variant: variant === 'default' ? 'Default' : variant,
            productCode: product.productCode,
            productName: product.name,
            category: product.category,
            unit: product.unit,
            productId: product.id,
            productObj: product,
            isFirstVariant: Object.keys(product.shopifySkus)[0] === variant
          });
        });
      }
    });

    return mappings;
  };

  const mappings = generateMappings();

  // Check if any variant of a product is already in Shopify (to avoid duplicate publish)
  const hasAnyVariantInShopify = (productObj) => {
    if (!productObj?.shopifySkus || typeof productObj.shopifySkus !== 'object') return false;
    return Object.values(productObj.shopifySkus).some(sku => sku && shopifyStatuses[sku]);
  };

  const getShopifyStatusLabel = (sku) => {
    const s = shopifyStatuses[sku];
    if (!s) return 'not_published';
    return s.status || 'draft';
  };

  const filteredMappings = mappings.filter(m => {
    const matchesCategory = categoryFilter === 'ALL' || m.category === categoryFilter;
    if (!matchesCategory) return false;
    if (!shopifyEnabled || shopifyStatusFilter === 'ALL') return true;
    const status = getShopifyStatusLabel(m.shopifySku);
    return status === shopifyStatusFilter;
  });

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading SKU mappings...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">SHOPIFY SKU MAPPING</h2>
          <p>View all Shopify SKU mappings and live product status</p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={fetchShopifyStatuses}
          disabled={statusLoading}
          style={{ fontSize: '13px' }}
        >
          {statusLoading ? 'Syncing...' : '↻ Refresh Shopify Status'}
        </button>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginRight: '8px', minWidth: '120px' }}>
              Category:
            </span>
            {[
              { value: 'ALL', label: 'All' },
              { value: 'OILS', label: 'Oils' },
              { value: 'SCENT_MACHINES', label: 'Diffuser Machines' },
              { value: 'MACHINES_SPARES', label: 'Spares' },
              { value: 'RAW_MATERIALS', label: 'Raw Materials' }
            ].map(cat => (
              <button
                key={cat.value}
                className={`btn ${categoryFilter === cat.value ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setCategoryFilter(cat.value)}
                style={{ fontSize: '13px', padding: '8px 16px' }}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {shopifyEnabled && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginRight: '8px', minWidth: '120px' }}>
                Shopify Status:
              </span>
              {[
                { value: 'ALL',          label: 'All',          color: null },
                { value: 'active',       label: 'Active',       color: '#10b981' },
                { value: 'draft',        label: 'Draft',        color: '#f59e0b' },
                { value: 'archived',     label: 'Archived',     color: '#6b7280' },
                { value: 'not_published',label: 'Not Published', color: '#ef4444' },
              ].map(s => (
                <button
                  key={s.value}
                  className={`btn ${shopifyStatusFilter === s.value ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShopifyStatusFilter(s.value)}
                  style={{
                    fontSize: '13px', padding: '8px 16px',
                    ...(shopifyStatusFilter === s.value && s.color ? { borderColor: s.color, color: s.color, background: `${s.color}22` } : {})
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Info Card */}
      <div className="card" style={{ marginBottom: '24px', background: 'rgba(59,130,246,0.08)', borderLeft: '4px solid #3b82f6', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <div style={{ fontSize: '24px' }}>ℹ️</div>
          <div>
            <h3 style={{ fontSize: '14px', fontWeight: '700', marginBottom: '8px', color: '#93c5fd' }}>
              About SKU Mappings
            </h3>
            <p style={{ fontSize: '13px', color: '#93c5fd', lineHeight: '1.6', margin: 0 }}>
              SKU mappings are automatically generated from your products. Essential oils have 5 variants
              (SA_CA, SA_HF, SA_CDIFF, SA_1L, SA_PRO), while machines/spares and raw materials have a single default SKU.
              To edit SKUs, go to <strong>Product Management</strong>.
            </p>
          </div>
        </div>
      </div>

      {/* Mappings Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        {filteredMappings.length === 0 ? (
          <p style={{ color: 'rgba(232,234,242,0.45)', textAlign: 'center', padding: '40px' }}>
            No SKU mappings found for this category.
          </p>
        ) : (
          <>
            <div className="table-scroll" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Shopify SKU</th>
                    <th>Variant</th>
                    <th>Size</th>
                    <th>Product Code</th>
                    <th>Product Name</th>
                    <th>Category</th>
                    <th>Unit</th>
                    {shopifyEnabled && <th>Shopify Status</th>}
                    {shopifyEnabled && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredMappings.map(mapping => {
                    const statusBadge = getShopifyStatusBadge(mapping.shopifySku);
                    const anyInShopify = hasAnyVariantInShopify(mapping.productObj);
                    // Count missing variants for this product
                    const missingCount = mapping.productObj?.shopifySkus
                      ? Object.values(mapping.productObj.shopifySkus).filter(s => s && !shopifyStatuses[s]).length
                      : 0;
                    // Publish: no variants in Shopify at all
                    const canPublish = shopifyEnabled
                      && mapping.isFirstVariant
                      && mapping.category === 'OILS'
                      && !anyInShopify;
                    // Add Missing: some variants exist but some are missing
                    const canAddMissing = shopifyEnabled
                      && mapping.isFirstVariant
                      && mapping.category === 'OILS'
                      && anyInShopify
                      && missingCount > 0;
                    return (
                      <tr key={mapping.id}>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: '700', color: '#93c5fd' }}>
                          {mapping.shopifySku}
                        </td>
                        <td>
                          {mapping.variant ? (
                            <span className="badge badge-secondary" style={{ fontSize: '11px' }}>
                              {mapping.variant}
                            </span>
                          ) : (
                            <span style={{ color: 'rgba(232,234,242,0.3)', fontSize: '12px' }}>Default</span>
                          )}
                        </td>
                        <td>
                          {SKU_SIZES[mapping.variant] ? (
                            <span style={{
                              fontSize: '12px', fontWeight: '700',
                              color: '#a5b4fc',
                              background: 'rgba(165,180,252,0.1)',
                              border: '1px solid rgba(165,180,252,0.25)',
                              borderRadius: '6px',
                              padding: '3px 8px',
                              display: 'inline-block'
                            }}>
                              {SKU_SIZES[mapping.variant]}
                            </span>
                          ) : (
                            <span style={{ color: 'rgba(232,234,242,0.25)', fontSize: '12px' }}>—</span>
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                          {mapping.productCode}
                        </td>
                        <td style={{ fontWeight: '600' }}>{mapping.productName}</td>
                        <td>
                          <span className="badge" style={{ fontSize: '11px' }}>
                            {getCategoryLabel(mapping.category)}
                          </span>
                        </td>
                        <td style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)' }}>{mapping.unit}</td>
                        {shopifyEnabled && (
                          <td>
                            {statusBadge || (
                              <span style={{ fontSize: '11px', color: 'rgba(232,234,242,0.3)' }}>Not Published</span>
                            )}
                          </td>
                        )}
                        {shopifyEnabled && (
                          <td>
                            {canPublish && (
                              <button
                                className="btn btn-primary"
                                style={{ fontSize: '11px', padding: '4px 10px' }}
                                disabled={publishing[mapping.productId]}
                                onClick={() => handlePublish(mapping)}
                              >
                                {publishing[mapping.productId] ? 'Publishing...' : '↑ Publish'}
                              </button>
                            )}
                            {canAddMissing && (
                              <button
                                className="btn"
                                style={{
                                  fontSize: '11px', padding: '4px 10px',
                                  background: 'rgba(245,158,11,0.15)',
                                  border: '1px solid rgba(245,158,11,0.4)',
                                  color: '#f59e0b'
                                }}
                                disabled={publishing[`missing_${mapping.productId}`]}
                                onClick={() => handleAddMissingVariants(mapping)}
                              >
                                {publishing[`missing_${mapping.productId}`]
                                  ? 'Adding...'
                                  : `+ Add Missing (${missingCount})`}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: '16px', fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>
              Showing {filteredMappings.length} of {mappings.length} SKU mappings
            </div>
          </>
        )}
      </div>

      {/* Statistics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '24px' }}>
        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#3b82f6', marginBottom: '8px' }}>
            {mappings.filter(m => m.category === 'OILS').length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Oil SKUs</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#ec4899', marginBottom: '8px' }}>
            {mappings.filter(m => m.category === 'SCENT_MACHINES').length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Scent Machine SKUs</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#8b5cf6', marginBottom: '8px' }}>
            {mappings.filter(m => m.category === 'MACHINES_SPARES').length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Spares SKUs</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#f59e0b', marginBottom: '8px' }}>
            {mappings.filter(m => m.category === 'RAW_MATERIALS').length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Raw Materials SKUs</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#10b981', marginBottom: '8px' }}>
            {mappings.length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Total SKUs</div>
        </div>
      </div>
    </div>
  );
}
