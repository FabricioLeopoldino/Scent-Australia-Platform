import { useState, useEffect } from 'react';
import { useSearch, useLocation } from 'wouter';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { displayStock } from '../utils/unitConversion';
import { getStockStatus as getSharedStockStatus, effectiveMin, shelfStock, isSaProduct } from '../utils/stockStatus';
import { exportProductsToExcel } from '../utils/excelExport';
import BinLocationInput from '../components/BinLocationInput';
import { GlowingEffect } from '../components/GlowingEffect';
import MlHelper from '../components/MlHelper';
import { LiquidMetalButton } from '../components/LiquidMetalButton';
import RegisterFragranceModal from '../components/RegisterFragranceModal';
import AdjustStockModal from '../components/AdjustStockModal';
import ProductSheet, { Swatch } from '../components/ProductSheet';
import { SECTORS, destinationByStock } from '../../../shared/sectors.js';

// libraryMode (D15 follow-up, 2026-07-30): renders this exact same page — same
// engine, same product-code sequence, same endpoints — as a locked-down,
// oils-only "Fragrance Library" experience instead of the generic Products
// screen. No new data path: it only hides/renames UI so oil registration has a
// single, dedicated-feeling door that can't wander into other categories.
//
// Stage 1 (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.2, §2.6) makes it two pages:
//   company="SA" → SA Fragrances, in SA's menu: SA's oils, SA's balance;
//   no company   → the Fragrance Library's All stock: every oil, its total and
//                  where it sits, and who it is registered with.
// Every Stage 1 branch tests saView / fullLibrary, never bare libraryMode, so
// the Products page cannot move.
export default function ProductManagement({ user, libraryMode = false, company = null }) {
  const saView = libraryMode && company === 'SA';
  const fullLibrary = libraryMode && !company;
  // Not libraryMode: SA's Stock Management (PRD_H2_STOCK_MANAGEMENT.md §2.2) —
  // every non-oil product, which Products, Diffusers, Stock and Raw Materials
  // used to show between them.
  const stockMode = !libraryMode;
  const [, navigate] = useLocation();
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [products, setProducts] = useState([]);
  const [filteredProducts, setFilteredProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState(libraryMode ? 'OILS' : 'ALL');
  const [showInactive, setShowInactive]     = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showIncomingOnly, setShowIncomingOnly] = useState(false);
  // Same chips as the Stock page (owner, 2026-10-15). "Out of Stock" takes
  // negative too: both mean nothing on the shelf.
  const [statusFilter, setStatusFilter] = useState('ALL');
  // All stock only: which company the oil is registered with (S6).
  const [companyFilter, setCompanyFilter] = useState('ALL');
  const [registerFor, setRegisterFor] = useState(null);   // the oil open in the Register window
  const [adjustFor, setAdjustFor] = useState(null);       // the product open in the Adjust window (PRD_H2 §2.4)
  const [sheetFor, setSheetFor] = useState(null);         // the product open in its sheet (PRD_H2 §2.3)
  // Stock Management: the diffusers' colour, as round swatches (PRD_H2 §2.2).
  const [colorFilter, setColorFilter] = useState('');
  const [registerInSa, setRegisterInSa] = useState(true); // Add Oil, All stock: register it in SA as well
  const [addForSku, setAddForSku] = useState(null);       // Add Oil opened from a PO line's unknown code
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  // Sequence suggestion state
  const [seqSuggestion, setSeqSuggestion] = useState(null);

  // Aliases states
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [aliasProduct, setAliasProduct] = useState(null);
  const [aliases, setAliases] = useState([]);
  const [newAlias, setNewAlias] = useState('');
  const [aliasLoading, setAliasLoading] = useState(false);

  // Global Aliases view states
  const [showAllAliases, setShowAllAliases] = useState(false);
  const [allAliases, setAllAliases] = useState([]);
  const [aliasSearch, setAliasSearch] = useState('');
  const [allAliasesLoading, setAllAliasesLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    category: 'OILS',
    productCode: '',
    tag: '',
    unit: 'mL',
    currentStock: 0,
    minStockLevel: 0,
    supplier: '',
    supplier_code: '',
    unitPerBox: 1,
    shopifySkus: {},
    skuMultipliers: {},
    bin_location: '',
    sub_category: '',
    color: '',
    exclusivity: 'SHARED'
  });

  // Legacy deep-link (pre-libraryMode): /products?filter=OILS — a pure UI
  // convenience, no new data path. Ignored in libraryMode, which is always OILS.
  const search = useSearch();
  useEffect(() => {
    const params = new URLSearchParams(search);
    // All stock: ?add=<Shopify code> — "Register now" on a PO line whose code
    // no oil carries opens Add Oil with the tag the code's number gives. The
    // server mints the oil's Shopify codes from the tag digits, so the line
    // matches after "Read again" (a non-standard code will not, and says so).
    const sku = fullLibrary && ['admin', 'root'].includes(user.role) ? params.get('add') : null;
    if (sku) {
      const digits = sku.match(/(\d+)$/)?.[1];
      setEditingProduct(null);
      resetForm();
      if (digits) setFormData((f) => ({ ...f, tag: `#SA${digits}` }));
      setRegisterInSa(true);
      setAddForSku(sku);
      setShowAddModal(true);
    }
    // All stock: ?find=<code>[&inactive=1] — a PO line whose code an existing
    // (possibly inactive) oil carries lands on that oil, ready to Reactivate (S5).
    if (fullLibrary && params.get('find')) {
      setSearchTerm(params.get('find'));
      setShowInactive(params.get('inactive') === '1');
    }
    if (libraryMode) return;
    const requestedFilter = params.get('filter');
    if (requestedFilter) setCategoryFilter(requestedFilter);
  }, [search, libraryMode]);

  useEffect(() => {
    fetchProducts();
  }, []);

  // libraryMode belongs in here even though the routes now carry keys and force
  // a remount. It is what the filter actually branches on, and leaving it out is
  // what let the Fragrance Library show the Products page's rows: the prop
  // changed, the component re-rendered, and this effect did not re-run because
  // nothing it watched had moved. Correct on its own terms, so the page cannot
  // break again if someone removes the keys.
  useEffect(() => {
    filterProducts();
  }, [products, categoryFilter, searchTerm, showIncomingOnly, showInactive, libraryMode, statusFilter, companyFilter, colorFilter]);

  // Compute next Tag/ProductCode suggestion when category changes (new product only)
  useEffect(() => {
    if (editingProduct || !showAddModal) return;
    const catProducts = products.filter(p => p.category === formData.category);
    if (!catProducts.length) { setSeqSuggestion(null); return; }

    const extract = (str) => {
      const m = str?.match(/(\D*)(\d+)(\D*)$/);
      return m ? { prefix: m[1], num: parseInt(m[2]), pad: m[2].length, suffix: m[3] } : null;
    };

    const tagParsed = catProducts
      .map(p => extract(p.tag))
      .filter(Boolean)
      .sort((a, b) => b.num - a.num)[0];

    const codeParsed = catProducts
      .map(p => extract(p.productCode))
      .filter(Boolean)
      .sort((a, b) => b.num - a.num)[0];

    setSeqSuggestion({
      lastTag: catProducts.find(p => extract(p.tag)?.num === tagParsed?.num)?.tag || null,
      suggestedTag: tagParsed ? tagParsed.prefix + String(tagParsed.num + 1).padStart(tagParsed.pad, '0') + tagParsed.suffix : null,
      lastCode: catProducts.find(p => extract(p.productCode)?.num === codeParsed?.num)?.productCode || null,
      suggestedCode: codeParsed ? codeParsed.prefix + String(codeParsed.num + 1).padStart(codeParsed.pad, '0') + codeParsed.suffix : null,
    });
  }, [formData.category, showAddModal, editingProduct]);

  const fetchProducts = async () => {
    try {
      // All stock needs only the oils. SA Fragrances keeps the whole list, so
      // its Excel export stays the one SA has always had.
      const res = await fetch(fullLibrary ? '/api/products?category=OILS' : '/api/products');
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching products:', error);
      setLoading(false);
    }
  };

  const isMember = (p, c) => p.registrations?.[c]?.active === true;
  const patchRegistrations = (id, registrations) =>
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, registrations } : p)));

  const filterProducts = () => {
    let filtered = products;

    // Oils are managed ONLY in the Fragrance Library (libraryMode) now — the
    // generic Products page never lists, filters to, or lets you create them,
    // so there is exactly one door for oil CRUD (create/edit/archive).
    filtered = libraryMode
      ? filtered.filter(p => p.category === 'OILS')
      : filtered.filter(p => p.category !== 'OILS');
    // SA Fragrances lists the oils with an active SA registration (S6) — SA's
    // membership. Inactive / Reactivate stay the oil's own status, as live (S1).
    if (saView) filtered = filtered.filter(isSaProduct);
    if (fullLibrary && companyFilter !== 'ALL') {
      // Membership = an ACTIVE registration, the one rule everywhere (fix round 2, R6).
      filtered = filtered.filter(p => companyFilter === 'NONE'
        ? !isMember(p, 'SA') && !isMember(p, 'MUSE')
        : isMember(p, companyFilter));
    }

    if (!libraryMode && categoryFilter !== 'ALL') {
      filtered = filtered.filter(p => p.category === categoryFilter);
    }
    if (stockMode && colorFilter) filtered = filtered.filter((p) => p.color === colorFilter);

    if (searchTerm) {
      filtered = filtered.filter(p =>
        (p.name?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
        (p.productCode?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
        (p.tag?.toLowerCase() ?? '').includes(searchTerm.toLowerCase())
      );
    }

    if (showIncomingOnly) {
      filtered = filtered.filter(p => Array.isArray(p.incomingOrders) && p.incomingOrders.length > 0);
    }

    if (statusFilter !== 'ALL') {
      filtered = filtered.filter(p => {
        const key = getSharedStockStatus(p).key;
        // "Low Stock" is everything below its minimum, Critical included — the
        // usual order-list filter must not lose the most urgent (code review).
        return statusFilter === 'OUT' ? (key === 'OUT' || key === 'NEGATIVE')
          : statusFilter === 'LOW' ? (key === 'LOW' || key === 'CRITICAL')
          : key === statusFilter;
      });
    }

    if (showInactive) {
      filtered = filtered.filter(p => (p.status || 'active') === 'inactive');
    } else {
      filtered = filtered.filter(p => (p.status || 'active') === 'active');
    }

    setFilteredProducts(filtered);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const url = editingProduct
        ? `/api/products/${editingProduct.id}`
        : '/api/products';

      const method = editingProduct ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData, userId: user?.id || null,
          // A new oil is registered in SA unless All stock unticks it (C6);
          // SA Fragrances sends nothing, so the server's default (SA) applies.
          ...(fullLibrary && !editingProduct && { registerIn: registerInSa ? ['SA'] : [] }),
        })
      });

      if (res.ok) {
        showToast(editingProduct ? 'Product updated!' : 'Product created!', 'success');
        setShowAddModal(false);
        setAddForSku(null);
        setEditingProduct(null);
        resetForm();
        fetchProducts();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Error saving product', 'error');
      }
    } catch (error) {
      showToast('Error saving product: ' + error.message, 'error');
    }
  };

  const handleDelete = async (productId) => {
    setConfirmState({ message: 'Are you sure you want to delete this product?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/products/${productId}?userId=${user?.id || ''}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          showToast('Product deleted!', 'success');
          fetchProducts();
        } else {
          // Surfaces the "has transaction history — deactivate instead" guard
          // and the admin/root permission check, instead of silently no-op'ing.
          const body = await res.json().catch(() => ({}));
          showToast(body.error || `Failed to delete product (${res.status})`, 'error');
        }
      } catch (error) {
        showToast('Error deleting product: ' + error.message, 'error');
      }
    }});
  };

  const handleToggleStatus = async (product) => {
    const newStatus = (product.status || 'active') === 'active' ? 'inactive' : 'active';
    try {
      const res = await fetch(`/api/products/${product.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, userId: user?.id })
      });
      if (res.ok) {
        showToast(`${product.name} set to ${newStatus}`, newStatus === 'active' ? 'success' : 'warning');
        fetchProducts();
      }
    } catch (err) {
      showToast('Error updating status: ' + err.message, 'error');
    }
  };

  const handleOpenAliasModal = async (product) => {
    setAliasProduct(product);
    setNewAlias('');
    setShowAliasModal(true);
    setAliasLoading(true);
    try {
      const res = await fetch(`/api/products/${product.id}/aliases`);
      const data = await res.json();
      setAliases(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error fetching aliases:', err);
      setAliases([]);
    } finally {
      setAliasLoading(false);
    }
  };

  const handleAddAlias = async (e) => {
    e.preventDefault();
    if (!newAlias.trim()) return;
    try {
      const res = await fetch(`/api/products/${aliasProduct.id}/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias_name: newAlias.trim() })
      });
      if (res.ok) {
        const added = await res.json();
        setAliases([...aliases, added]);
        setNewAlias('');
      }
    } catch (err) {
      showToast('Error adding alias: ' + err.message, 'error');
    }
  };

  const handleDeleteAlias = async (aliasId) => {
    try {
      await fetch(`/api/products/aliases/${aliasId}`, { method: 'DELETE' });
      setAliases(aliases.filter(a => a.id !== aliasId));
    } catch (err) {
      showToast('Error deleting alias: ' + err.message, 'error');
    }
  };

  const fetchAllAliases = async () => {
    setAllAliasesLoading(true);
    try {
      const res = await fetch('/api/aliases');
      const data = await res.json();
      setAllAliases(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast('Error loading aliases: ' + err.message, 'error');
      setAllAliases([]);
    } finally {
      setAllAliasesLoading(false);
    }
  };

  const handleExportWithAliases = async () => {
    try {
      const res = await fetch('/api/aliases');
      const data = await res.json();
      exportProductsToExcel(products, Array.isArray(data) ? data : []);
    } catch (err) {
      showToast('Error fetching aliases for export: ' + err.message, 'error');
      exportProductsToExcel(products, []);
    }
  };

  const handleToggleAllAliases = () => {
    if (!showAllAliases) fetchAllAliases();
    setShowAllAliases(v => !v);
    setAliasSearch('');
  };

  const handleDeleteGlobalAlias = async (aliasId) => {
    try {
      await fetch(`/api/products/aliases/${aliasId}`, { method: 'DELETE' });
      setAllAliases(allAliases.filter(a => a.id !== aliasId));
      showToast('Alias removed', 'success');
    } catch (err) {
      showToast('Error deleting alias: ' + err.message, 'error');
    }
  };

  const handleEdit = (product) => {
    setAddForSku(null);
    setEditingProduct(product);
    setFormData({
      name: product.name,
      category: product.category,
      productCode: product.productCode,
      tag: product.tag,
      unit: product.unit,
      currentStock: product.currentStock,
      minStockLevel: product.minStockLevel,
      supplier: product.supplier || '',
      supplier_code: product.supplier_code || '',
      unitPerBox: product.unitPerBox || 1,
      shopifySkus: product.shopifySkus || {},
      skuMultipliers: product.skuMultipliers || {},
      bin_location: product.bin_location || '',
      sub_category: product.sub_category || '',
      color: product.color || '',
      exclusivity: product.exclusivity || 'SHARED'
    });
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      // Oils only ever get created in libraryMode (the "Oils" category was removed
      // from the generic dropdown); default the generic page to Raw Materials instead.
      category: libraryMode ? 'OILS' : 'RAW_MATERIALS',
      productCode: '',
      tag: '',
      // Oils are measured in mL; everything this generic page creates is
      // counted in units. Defaulting to mL here created 'tst' (13 Oct) as a
      // diffuser machine measured in millilitres. Raw materials can still be
      // switched to mL by hand (Ethanol is).
      unit: libraryMode ? 'mL' : 'units',
      currentStock: 0,
      minStockLevel: 0,
      supplier: '',
      supplier_code: '',
      unitPerBox: 1,
      shopifySkus: {},
      skuMultipliers: {},
      bin_location: '',
      sub_category: '',
      color: '',
      exclusivity: 'SHARED'
    });
  };

  const getCategoryLabel = (category) => {
    const labels = {
      'OILS': 'Oils',
      'SA_SCENTED_PRODUCTS': 'Scented Products',
      'SCENT_MACHINES': 'Diffuser Machines',
      'MACHINES_SPARES': 'Spares',
      'RAW_MATERIALS': 'Raw Materials'
    };
    return labels[category] || category;
  };

  const getCategoryBadge = (category) => {
    const badges = {
      'OILS': 'badge-blue',
      'SA_SCENTED_PRODUCTS': 'badge-pink',
      'SCENT_MACHINES': 'badge-secondary',
      'MACHINES_SPARES': 'badge-purple',
      'RAW_MATERIALS': 'badge-green'
    };
    return badges[category] || 'badge-gray';
  };

  // The sheet's actions: today's operations for this place, each with the
  // permission it had — admin and root act, everyone else reads (PRD_H2 A1).
  // SA Fragrances has no Adjust: an oil is adjusted in the Fragrance Library (O1).
  const sheetActions = (p) => {
    if (!['admin', 'root'].includes(user.role)) return [];
    const go = (fn) => () => { setSheetFor(null); fn(); };
    const inactive = (p.status || 'active') === 'inactive';
    return [
      ...(saView ? [] : [{ key: 'adjust', label: 'Adjust stock', primary: true, onClick: go(() => setAdjustFor(p)) }]),
      ...(fullLibrary ? [
        { key: 'move', label: 'Move', title: 'Transfer this oil between the stocks', onClick: go(() => navigate(`/transfers?oil=${encodeURIComponent(p.id)}`)) },
        { key: 'register', label: 'Register', title: 'Register this oil in SA or MUSE', onClick: go(() => setRegisterFor(p)) },
      ] : []),
      { key: 'edit', label: 'Edit', onClick: go(() => handleEdit(p)) },
      { key: 'aliases', label: 'Aliases', title: 'Alternative names for this product', onClick: go(() => handleOpenAliasModal(p)) },
      { key: 'status', label: inactive ? '↑ Reactivate' : '↓ Deactivate', onClick: go(() => handleToggleStatus(p)) },
      { key: 'delete', label: 'Delete', danger: true, onClick: go(() => handleDelete(p.id)) },
    ];
  };
  // The colours the listed products carry, for the swatches (only diffusers have one today).
  const colours = stockMode ? [...new Set(products.filter((p) => p.category !== 'OILS' && p.color
    && (p.status || 'active') === (showInactive ? 'inactive' : 'active')).map((p) => p.color))].sort() : [];

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading products...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <h2 className="page-title">{saView ? 'SA Fragrances' : fullLibrary ? 'All stock' : 'Stock Management'}</h2>
        <p style={{ color: 'rgba(232,234,242,0.45)', marginTop: '8px' }}>
          {saView ? "SA's oils — SA's balance. The rest is in the Fragrance Library."
            : fullLibrary ? 'Every oil — main store, SA and MUSE'
            : 'Diffusers, spare parts and raw materials. Click a name to open its sheet.'}
        </p>
      </div>

      {/* An old Stock page bookmark (PRD_H2 §2.1): oils moved, say where. */}
      {stockMode && new URLSearchParams(search).get('from') === 'stock' && (
        <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.3)', color: '#7dd3fc' }}>
          Fragrance oils are adjusted in the Fragrance Library: open the oil in All stock and choose Adjust stock.
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className="btn"
          onClick={handleExportWithAliases}
          style={{ background: '#10b981', color: 'white', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <span>📑</span>
          Export to Excel
        </button>

        <button
          className="btn"
          onClick={handleToggleAllAliases}
          style={{ background: showAllAliases ? '#6366f1' : 'rgba(99,102,241,0.15)', color: showAllAliases ? 'white' : '#a5b4fc', border: '1px solid rgba(99,102,241,0.4)' }}
        >
          🏷️ {showAllAliases ? 'Hide Aliases' : 'View All Aliases'}
        </button>

        {/* Right-side group: BOM (irrelevant to raw oils, hidden in libraryMode) + Add */}
        <div style={{ display: 'flex', gap: 12, marginLeft: 'auto', alignItems: 'center' }}>
          {!libraryMode && <LiquidMetalButton label="🧩 BOM" width={108} onClick={() => window.location.href = '/sa/bom'} />}
          {/* It was a button on the Diffusers page; both go to the BOM section in H3. */}
          {stockMode && <LiquidMetalButton label="🧩 Diffuser BOM" width={150} onClick={() => window.location.href = '/sa/diffuser-bom'} />}
          {['admin', 'root'].includes(user.role) && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setEditingProduct(null);
                resetForm();
                setRegisterInSa(true);
                setAddForSku(null);
                setShowAddModal(true);
              }}
            >
              {libraryMode ? '+ Add Oil' : '+ Add Product'}
            </button>
          )}
        </div>
      </div>

      {/* Global Aliases Panel */}
      {showAllAliases && (
        <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, color: '#a5b4fc', fontSize: '16px' }}>🏷️ All Product Aliases</h3>
            <span style={{ color: 'rgba(232,234,242,0.45)', fontSize: '13px' }}>{allAliases.length} alias{allAliases.length !== 1 ? 'es' : ''}</span>
          </div>
          <input
            type="text"
            className="input"
            placeholder="Search aliases or product names..."
            value={aliasSearch}
            onChange={e => setAliasSearch(e.target.value)}
            style={{ marginBottom: '16px' }}
          />
          {allAliasesLoading ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'rgba(232,234,242,0.45)' }}>Loading...</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(232,234,242,0.55)', fontWeight: 500 }}>Alias Name</th>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(232,234,242,0.55)', fontWeight: 500 }}>Base Product</th>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(232,234,242,0.55)', fontWeight: 500 }}>Code</th>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(232,234,242,0.55)', fontWeight: 500 }}>Category</th>
                    {['admin', 'root'].includes(user.role) && <th style={{ textAlign: 'center', padding: '8px 12px', color: 'rgba(232,234,242,0.55)', fontWeight: 500 }}>Delete</th>}
                  </tr>
                </thead>
                <tbody>
                  {allAliases
                    .filter(a => {
                      const q = aliasSearch.toLowerCase();
                      return !q || a.alias_name.toLowerCase().includes(q) || a.product_name.toLowerCase().includes(q) || (a.product_code || '').toLowerCase().includes(q);
                    })
                    .map(a => (
                      <tr key={a.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '10px 12px', color: '#e8eaf2' }}>{a.alias_name}</td>
                        <td style={{ padding: '10px 12px', color: 'rgba(232,234,242,0.8)' }}>{a.product_name}</td>
                        <td style={{ padding: '10px 12px', color: 'rgba(232,234,242,0.55)', fontFamily: 'monospace', fontSize: '12px' }}>{a.product_code || '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span className={`badge ${getCategoryBadge(a.category)}`} style={{ fontSize: '11px' }}>{getCategoryLabel(a.category)}</span>
                        </td>
                        {['admin', 'root'].includes(user.role) && (
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <button
                              onClick={() => handleDeleteGlobalAlias(a.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(239,68,68,0.7)', fontSize: '16px', padding: '2px 6px' }}
                              title="Delete alias"
                            >✕</button>
                          </td>
                        )}
                      </tr>
                    ))
                  }
                  {allAliases.filter(a => {
                    const q = aliasSearch.toLowerCase();
                    return !q || a.alias_name.toLowerCase().includes(q) || a.product_name.toLowerCase().includes(q) || (a.product_code || '').toLowerCase().includes(q);
                  }).length === 0 && (
                    <tr>
                      <td colSpan={['admin', 'root'].includes(user.role) ? 5 : 4} style={{ textAlign: 'center', padding: '24px', color: 'rgba(232,234,242,0.35)' }}>
                        No aliases found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '300px' }}>
            <input
              type="text"
              className="input"
              placeholder="Search by name, code, or tag..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/* Category chips hidden in libraryMode — this page is oils-only by design,
                nothing to switch between. "Oils" removed from the generic page's chips —
                oils are excluded here unconditionally; manage them in the Fragrance Library. */}
            {/* No "Scented" chip: the 354 retired Scented products stay out (O5)
                and show only under Show Inactive. */}
            {!libraryMode && [
              { value: 'ALL', label: 'All' },
              { value: 'SCENT_MACHINES', label: 'Diffusers' },
              { value: 'MACHINES_SPARES', label: 'Spare parts' },
              { value: 'RAW_MATERIALS', label: 'Raw materials' }
            ].map(cat => (
              <button
                key={cat.value}
                onClick={() => setCategoryFilter(cat.value)}
                className="btn"
                style={{
                  background: categoryFilter === cat.value ? '#3b82f6' : 'rgba(255,255,255,0.04)',
                  color: categoryFilter === cat.value ? 'white' : 'rgba(232,234,242,0.45)',
                  border: categoryFilter === cat.value ? 'none' : '1px solid rgba(255,255,255,0.07)',
                  fontSize: '13px',
                  padding: '8px 16px'
                }}
              >
                {cat.label}
              </button>
            ))}
            <button
              onClick={() => setShowIncomingOnly(v => !v)}
              className="btn"
              style={{
                background: showIncomingOnly ? '#3b82f6' : 'rgba(255,255,255,0.04)',
                color: showIncomingOnly ? 'white' : 'rgba(232,234,242,0.45)',
                border: showIncomingOnly ? 'none' : '1px solid rgba(255,255,255,0.07)',
                fontSize: '13px',
                padding: '8px 16px'
              }}
            >
              Incoming Orders
            </button>
            <button
              onClick={() => setShowInactive(v => !v)}
              className="btn"
              style={{
                background: showInactive ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.04)',
                color: showInactive ? '#f87171' : 'rgba(232,234,242,0.45)',
                border: showInactive ? '1px solid rgba(248,113,113,0.4)' : '1px solid rgba(255,255,255,0.07)',
                fontSize: '13px',
                padding: '8px 16px'
              }}
            >
              {showInactive ? '● Inactive Only' : '○ Show Inactive'}
            </button>
            {/* Who the oil is registered with (S6) — All stock only. */}
            {fullLibrary && [
              { value: 'ALL', label: 'All companies' },
              { value: 'SA', label: 'SA' },
              { value: 'MUSE', label: 'MUSE' },
              { value: 'NONE', label: 'Not registered' },
            ].map(c => (
              <button
                key={c.value}
                onClick={() => setCompanyFilter(c.value)}
                className="btn"
                style={{
                  background: companyFilter === c.value ? '#3b82f6' : 'rgba(255,255,255,0.04)',
                  color: companyFilter === c.value ? 'white' : 'rgba(232,234,242,0.45)',
                  border: companyFilter === c.value ? 'none' : '1px solid rgba(255,255,255,0.07)',
                  fontSize: '13px',
                  padding: '8px 16px'
                }}
              >
                {c.label}
              </button>
            ))}
            {/* SA's status — not on All stock (no minimum there, owner 27 Oct). */}
            {!fullLibrary && [
              { value: 'ALL',     label: 'All Status',     color: null },
              { value: 'HEALTHY', label: '✅ Healthy',      color: '#22c55e' },
              { value: 'CRITICAL', label: '🚨 Critical',     color: '#f87171' },
              { value: 'LOW',     label: '⚠️ Low Stock',    color: '#fbbf24' },
              { value: 'OUT',     label: '🔴 Out of Stock', color: '#ef4444' },
            ].map(st => (
              <button
                key={st.value}
                onClick={() => setStatusFilter(st.value)}
                className="btn"
                style={{
                  fontSize: '13px',
                  padding: '8px 16px',
                  background: statusFilter === st.value ? (st.color ? `${st.color}22` : 'rgba(59,130,246,0.18)') : 'rgba(255,255,255,0.04)',
                  color: statusFilter === st.value ? (st.color || '#3b82f6') : 'rgba(232,234,242,0.45)',
                  border: `1px solid ${statusFilter === st.value ? (st.color || '#3b82f6') + '66' : 'rgba(255,255,255,0.07)'}`,
                  fontWeight: statusFilter === st.value ? '700' : 'normal',
                }}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>
        {/* Colour swatches (PRD_H2 §2.2): round, named on hover and for screen
            readers, a ring when chosen. Only where the listed products carry a
            colour — today the diffusers. */}
        {stockMode && colours.length > 0 && ['ALL', 'SCENT_MACHINES'].includes(categoryFilter) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }} role="group" aria-label="Filter by colour">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Colour</span>
            {colours.map((c) => (
              <button key={c} type="button" onClick={() => setColorFilter((v) => (v === c ? '' : c))}
                aria-pressed={colorFilter === c} title={c} aria-label={`Colour ${c}`}
                style={{ width: 30, height: 30, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', background: 'transparent', transition: 'box-shadow 150ms',
                  border: colorFilter === c ? '2px solid #3b82f6' : '1px solid var(--border)',
                  boxShadow: colorFilter === c ? '0 0 0 3px rgba(59,130,246,0.25)' : 'none' }}>
                <Swatch color={c} size={18} />
              </button>
            ))}
            {colorFilter && (
              <button type="button" className="btn btn-secondary" onClick={() => setColorFilter('')} style={{ fontSize: 12, padding: '4px 10px' }}>
                Any colour
              </button>
            )}
          </div>
        )}
      </div>

      {/* Products Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        {/* SCROLLING (2026-09-15). The owner: "o sistema de filtro está ruim na
            questão de rolagem, coloca uma barra lateral." The filter chips and
            the column headings sat at the top of the page and the table then
            ran for as many rows as matched — 772 products here, 282 oils in the
            Fragrance Library — so scrolling to row 300 left you with no headings
            and no filters, and no way back except scrolling up again.
            The table now scrolls inside its own box with the headings pinned,
            which is what the Demand Planning table already did. */}
        <div className="table-scroll" style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '68vh' }}>
          <table className="table">
            <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: '#0e0e1a' }}>
              <tr>
                {/* Stock Management: the owner's columns (PRD_H2 §2.2). The tag
                    stays searchable and the bin location is on the sheet. */}
                {stockMode ? <th>Colour</th> : <th>Tag</th>}
                <th>Product Code</th>
                <th>Name</th>
                {/* Always "Oils" on All stock; the room goes to the Stock cell's lines. */}
                {!fullLibrary && <th>Category</th>}
                {!stockMode && <th>Bin Location</th>}
                <th>{fullLibrary ? 'Total stock' : stockMode ? 'Current Stock' : 'Stock'}</th>
                {/* No minimum or status on All stock: the central store holds every
                    company's oil, so no single minimum fits it (owner, 27 Oct). SA's
                    minimum and status live on SA Fragrances. */}
                {!fullLibrary && <th>Min Level</th>}
                {!fullLibrary && <th>Status</th>}
                <th>Incoming Orders</th>
                <th>Supplier</th>
                <th>Supplier Code</th>
                {['admin', 'root'].includes(user.role) && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map(product => {
                // SA Fragrances shows SA's balance; Products and All stock the total.
                const stock = saView ? shelfStock(product) : product.currentStock;
                const isNegative = stock < 0;
                const isInactive = (product.status || 'active') === 'inactive';
                return (
                  <tr
                    key={product.id}
                    style={isNegative ? {
                      background: 'rgba(239,68,68,0.08)',
                      borderLeft: '4px solid #dc2626'
                    } : isInactive ? {
                      opacity: showInactive ? 1 : 0.5,
                      borderLeft: '4px solid rgba(148,163,184,0.4)'
                    } : {}}
                  >
                    {stockMode
                      ? <td style={{ textAlign: 'center' }}>{product.color ? <Swatch color={product.color} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      : <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{product.tag}</td>}
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{product.productCode}</td>
                    <td style={{ fontWeight: '600' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {/* Opens the product sheet, for everyone (PRD_H2 §2.3). */}
                        <button type="button" onClick={() => setSheetFor(product)} title="Open the product sheet"
                          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600,
                            color: 'inherit', cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
                            textDecorationColor: 'rgba(148,163,184,0.35)', textUnderlineOffset: 3 }}>
                          {product.name}
                        </button>
                        {product.color && !stockMode && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                            fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)',
                            borderRadius: 5, padding: '1px 7px' }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: product.color.toLowerCase(),
                              border: '1px solid rgba(255,255,255,0.25)',
                              boxShadow: `0 0 4px ${product.color.toLowerCase()}66` }} />
                            {product.color}
                          </span>
                        )}
                        {isNegative && (
                          <span style={{
                            padding: '2px 8px', background: '#dc2626',
                            color: 'white', fontSize: '11px', fontWeight: '700', borderRadius: '4px'
                          }}>
                            🚨 NEGATIVE STOCK
                          </span>
                        )}
                        {isInactive && (
                          <span style={{
                            padding: '2px 8px',
                            background: 'rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.3)',
                            color: '#94a3b8', fontSize: '11px', fontWeight: '700', borderRadius: '4px'
                          }}>
                            INACTIVE
                          </span>
                        )}
                        {/* The companies the oil belongs to — active registrations only (S6, R6). */}
                        {fullLibrary && ['SA', 'MUSE'].filter((c) => isMember(product, c)).map((c) => (
                          <span key={c} title={`Registered in ${c}`} style={{
                            padding: '1px 7px', borderRadius: 5, fontSize: 10.5, fontWeight: 700,
                            color: c === 'SA' ? '#60a5fa' : '#d4b574',
                            border: `1px solid ${c === 'SA' ? 'rgba(96,165,250,0.4)' : 'rgba(212,181,116,0.45)'}`,
                          }}>
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    {!fullLibrary && (
                      <td>
                        <span className={`badge ${getCategoryBadge(product.category)}`}>
                          {getCategoryLabel(product.category)}
                        </span>
                        {stockMode && product.sub_category && (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>{product.sub_category}</div>
                        )}
                      </td>
                    )}
                    {!stockMode && (
                      <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                        {product.bin_location || '-'}
                      </td>
                    )}
                    <td>
                      <span style={{
                        fontWeight: isNegative ? '900' : 'normal',
                        color: isNegative ? '#dc2626' : 'inherit',
                        fontSize: isNegative ? '15px' : 'inherit'
                      }}>
                        {displayStock(stock, product.unit)}
                      </span>
                      {product.unitPerBox > 1 && (
                        <span style={{ fontSize: '11px', color: 'rgba(232,234,242,0.45)', marginLeft: '4px' }}>
                          ({product.stockBoxes} boxes)
                        </span>
                      )}
                      {isNegative && (
                        <div style={{
                          fontSize: '11px',
                          color: '#fca5a5',
                          fontWeight: '600',
                          marginTop: '4px'
                        }}>
                          ⚠️ {displayStock(Math.abs(stock), product.unit)} MISSING
                        </div>
                      )}
                      {/* Where the oil sits, under the total — inside this cell, not
                          extra columns: those squeezed the Actions buttons to "Sect",
                          "Inc" (visual check, 25 Oct). Always SA, then every other
                          stock that is not zero — shown even for an all-SA oil, or
                          the total reads as each company's balance (owner, 27 Oct).
                          Main store in blue: oil waiting for its split. MUSE as one
                          figure, then its units under it (owner, 29 Oct: "MUSE total
                          20 L, Atelier 10, Library 5, Archive 5"); MUSE's own shared
                          stock reads "Shared", so it is not taken for the total. */}
                      {fullLibrary && (() => {
                        const val = (k) => product.sectors?.[k] || 0;
                        const shown = (k) => Math.abs(val(k)) > 0.0005;
                        const museParts = SECTORS.filter((s) => s.company === 'MUSE' && shown(s.key));
                        const lines = [
                          ...(shown('MAIN') ? [{ key: 'MAIN', short: 'Main', label: 'Main store', v: val('MAIN') }] : []),
                          { key: 'SA', short: 'SA', label: 'SA', v: val('SA') },
                          ...(museParts.length ? [
                            { key: 'MUSE_TOTAL', short: 'MUSE total', label: 'MUSE, all units', v: museParts.reduce((t, s) => t + val(s.key), 0) },
                            ...museParts.map((s) => ({ key: s.key, short: s.key === 'MUSE' ? 'Shared' : s.short, label: s.label, v: val(s.key), sub: true })),
                          ] : []),
                        ];
                        return (
                          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 8, fontSize: 11, lineHeight: 1.5, marginTop: 4, whiteSpace: 'nowrap', justifyContent: 'start' }}>
                            {lines.flatMap((l) => {
                              const style = { color: l.v < 0 ? '#f87171' : l.key === 'MAIN' ? '#38bdf8' : 'var(--text-secondary)', fontWeight: l.v < 0 ? 700 : undefined };
                              const title = l.v < 0 ? `${l.label} is below zero — shown in red, never blocked` : l.label;
                              return [
                                <span key={`${l.key}-l`} style={{ ...style, ...(l.sub && { paddingLeft: 10 }) }} title={title}>{l.short}</span>,
                                <span key={`${l.key}-v`} style={{ ...style, textAlign: 'right' }} title={title}>{displayStock(l.v, product.unit)}</span>,
                              ];
                            })}
                          </div>
                        );
                      })()}
                    </td>
                    {!fullLibrary && <td>{displayStock(effectiveMin(product), product.unit)}{product.minStockAuto != null && ' (auto)'}</td>}
                    {!fullLibrary && (
                    <td>
                      {(() => {
                        // Low counts what is on order and reads the automatic minimum (utils/stockStatus).
                        const st = getSharedStockStatus(product);
                        const badge = st.key === 'HEALTHY' ? 'success' : st.key === 'LOW' ? 'warning' : 'danger';
                        return <span className={`badge badge-${badge}`}>{st.key === 'HEALTHY' ? 'Healthy' : st.label}</span>;
                      })()}
                    </td>
                    )}
                    <td>
                      {product.incomingOrders && product.incomingOrders.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {product.incomingOrders.map((order, idx) => (
                            <div key={idx} style={{
                              padding: '8px 10px',
                              background: 'rgba(251,191,36,0.07)',
                              border: '1px solid rgba(251,191,36,0.18)',
                              borderRadius: '6px',
                              fontSize: '12px'
                            }}>
                              {/* Row 1: PO number + qty + action buttons */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                                <span style={{ fontWeight: '700', color: '#fbbf24' }}>
                                  {order.orderNumber}
                                </span>
                                <span style={{ color: '#fbbf24' }}>
                                  ({displayStock(order.quantity, product.unit)})
                                </span>
                                {/* Whose order it is (P6): a MUSE one is not SA's on order. */}
                                {order.stock && order.stock !== 'SA' && (
                                  <span title="This purchase order is for MUSE: it is not counted as SA's on order"
                                    style={{ fontSize: 10, fontWeight: 700, color: '#d4b574', border: '1px solid rgba(212,181,116,0.45)', borderRadius: 4, padding: '1px 6px' }}>
                                    {destinationByStock(order.stock)?.label || order.stock}
                                  </span>
                                )}
                                {/* Cancelled in Shopify. The dangerous part of an
                                    order that no longer exists is not that it
                                    sits here — it is the green button beside it,
                                    which would bring in oil that is never
                                    coming. So the button goes and the reason
                                    takes its place; removing it stays a
                                    deliberate click, because a row that vanishes
                                    on its own teaches nobody anything. */}
                                {order.shopifyMissingSince && (
                                  <span style={{
                                    fontSize: '10px', fontWeight: 700, color: '#f87171',
                                    background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)',
                                    borderRadius: 4, padding: '2px 6px', marginLeft: 'auto',
                                  }}>
                                    cancelled in Shopify
                                  </span>
                                )}
                                {user.role !== 'technician' && (
                                  <button type="button" onClick={() => navigate(`~/purchase-orders?q=${encodeURIComponent(order.orderNumber)}`)}
                                    style={{ marginLeft: order.shopifyMissingSince ? 8 : 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#60a5fa' }}
                                    title="Receive, correct or cancel it in Purchase Orders">
                                    Open in Purchase Orders
                                  </button>
                                )}
                              </div>
                              {/* Row 2: ETA */}
                              {order.estimatedDeliveryDate && (
                                <div style={{ color: '#10b981', fontWeight: '600', marginBottom: '3px' }}>
                                  📅 ETA: {new Date(order.estimatedDeliveryDate).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}
                                </div>
                              )}
                              {/* Row 3: who added + when */}
                              <div style={{ color: 'rgba(232,234,242,0.35)', fontSize: '11px' }}>
                                Added by <span style={{ color: 'rgba(232,234,242,0.6)', fontWeight: '600' }}>{order.addedBy || '—'}</span>
                                {order.addedAt && (
                                  <> · {new Date(order.addedAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })} {new Date(order.addedAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })}</>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: 'rgba(232,234,242,0.3)', fontSize: '12px' }}>-</span>
                      )}
                    </td>
                    <td style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)' }}>
                      {product.supplier || '-'}
                    </td>
                    <td style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontFamily: 'monospace' }}>
                      {product.supplier_code || '-'}
                    </td>
                    {['admin', 'root'].includes(user.role) && (
                      <td>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleEdit(product)}
                            style={{ fontSize: '12px', padding: '6px 12px' }}
                          >
                            Edit
                          </button>
                          {/* Stock Management: what the Stock and Raw Materials pages
                              did. All stock: one stock of the oil (PRD_H2 §2.4, O1).
                              Not SA Fragrances: an oil is adjusted in the Library. */}
                          {!saView && (
                            <button
                              className="btn btn-primary"
                              onClick={() => setAdjustFor(product)}
                              style={{ fontSize: '12px', padding: '6px 12px' }}
                              title={fullLibrary ? 'Add or remove oil in one stock: SA or a MUSE stock' : 'Add or remove stock, with the reason and who did it'}
                            >
                              Adjust
                            </button>
                          )}
                          {fullLibrary && (
                            <>
                              <button
                                className="btn btn-secondary"
                                onClick={() => setRegisterFor(product)}
                                style={{ fontSize: '12px', padding: '6px 12px' }}
                                title="Register this oil in SA or MUSE"
                              >
                                Register
                              </button>
                              {/* Main store oil waiting for its split is the usual reason to move. */}
                              <button
                                className="btn btn-secondary"
                                onClick={() => navigate(`/transfers?oil=${encodeURIComponent(product.id)}`)}
                                style={{ fontSize: '12px', padding: '6px 12px',
                                  ...((product.sectors?.MAIN || 0) > 0 && { borderColor: '#38bdf8', color: '#38bdf8' }) }}
                                title="Transfer this oil between the stocks"
                              >
                                Move
                              </button>
                            </>
                          )}
                          {/* Stock Management keeps its rows short: the rest of the
                              actions are on the sheet (PRD_H2 §2.2), one click away. */}
                          {stockMode ? (
                            <button
                              className="btn btn-secondary"
                              onClick={() => setSheetFor(product)}
                              style={{ fontSize: '12px', padding: '6px 12px' }}
                              title="More: Edit, Aliases, Deactivate, Delete — on the product sheet"
                              aria-label={`More actions for ${product.name}`}
                            >
                              ⋯
                            </button>
                          ) : (<>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleOpenAliasModal(product)}
                            style={{ fontSize: '12px', padding: '6px 12px' }}
                            title="Alternative names for this product"
                          >
                            Aliases
                          </button>
                          <button
                            className="btn"
                            onClick={() => handleToggleStatus(product)}
                            style={{
                              fontSize: '12px', padding: '6px 12px',
                              background: isInactive ? 'rgba(16,185,129,0.12)' : 'rgba(148,163,184,0.08)',
                              color: isInactive ? '#10b981' : '#94a3b8',
                              border: isInactive ? '1px solid rgba(16,185,129,0.35)' : '1px solid rgba(148,163,184,0.25)'
                            }}
                            title={isInactive ? 'Reactivate product' : 'Set as Inactive'}
                          >
                            {isInactive ? '↑ Reactivate' : '↓ Deactivate'}
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => handleDelete(product.id)}
                            style={{ fontSize: '12px', padding: '6px 12px' }}
                          >
                            Delete
                          </button>
                          </>)}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: '16px', fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>
          Showing {filteredProducts.length} of {products.length} products
        </div>
      </div>

      {/* Add/Edit Product Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>{libraryMode ? (editingProduct ? 'Edit Oil' : 'Add New Oil') : (editingProduct ? 'Edit Product' : 'Add New Product')}</h2>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>

            <form onSubmit={handleSubmit}>
              {addForSku && (
                <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, fontSize: 13,
                  background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.3)', color: 'var(--text-secondary)' }}>
                  For Shopify code <strong style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{addForSku}</strong> — the
                  tag carries its number, so the purchase order line matches after "Read again".
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div className="form-group">
                  <label>Product Name *</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    required
                  />
                </div>

                {libraryMode ? (
                  // Locked, not just defaulted — the Fragrance Library is oils-only by
                  // design (one door, one engine, one sequence — never let this drift
                  // into another category by accident).
                  <div className="form-group">
                    <label>Category</label>
                    <input className="input" value="Oils" disabled style={{ opacity: 0.65, cursor: 'not-allowed' }} />
                  </div>
                ) : (
                  <div className="form-group">
                    <label>Category *</label>
                    <select
                      className="input"
                      value={formData.category}
                      onChange={(e) => setFormData({...formData, category: e.target.value, productCode: '', tag: '', unit: 'units'})}
                      required
                    >
                      {/* Oils removed — created only in the Fragrance Library (libraryMode) now. */}
                      <option value="SCENT_MACHINES">Diffuser Machines</option>
                      <option value="MACHINES_SPARES">Spares</option>
                      <option value="RAW_MATERIALS">Raw Materials</option>
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label style={{ margin: 0 }}>Product Code</label>
                    {!editingProduct && seqSuggestion?.suggestedCode && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                        <span style={{ color: 'rgba(232,234,242,0.4)' }}>Last: <b style={{ color: 'rgba(232,234,242,0.65)' }}>{seqSuggestion.lastCode}</b></span>
                        <button type="button" onClick={() => setFormData({...formData, productCode: seqSuggestion.suggestedCode})}
                          style={{ padding: '2px 8px', borderRadius: '20px', border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)', color: '#10b981', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>
                          Use {seqSuggestion.suggestedCode}
                        </button>
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    className="input"
                    value={formData.productCode}
                    onChange={(e) => setFormData({...formData, productCode: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label style={{ margin: 0 }}>Tag</label>
                    {!editingProduct && seqSuggestion?.suggestedTag && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                        <span style={{ color: 'rgba(232,234,242,0.4)' }}>Last: <b style={{ color: 'rgba(232,234,242,0.65)' }}>{seqSuggestion.lastTag}</b></span>
                        <button type="button" onClick={() => setFormData({...formData, tag: seqSuggestion.suggestedTag})}
                          style={{ padding: '2px 8px', borderRadius: '20px', border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)', color: '#10b981', cursor: 'pointer', fontSize: '11px', fontWeight: '600' }}>
                          Use {seqSuggestion.suggestedTag}
                        </button>
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    className="input"
                    value={formData.tag}
                    onChange={(e) => setFormData({...formData, tag: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Unit *</label>
                  <select
                    className="input"
                    value={formData.unit}
                    onChange={(e) => setFormData({...formData, unit: e.target.value})}
                    required
                  >
                    <option value="mL">mL</option>
                    <option value="units">units</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Current Stock {formData.unit === 'mL' ? '(mL)' : `(${formData.unit})`}</label>
                  <input
                    type="number"
                    className="input"
                    value={formData.currentStock}
                    title={editingProduct ? 'Stock cannot be changed here — use the Adjust button on the product card' : (formData.unit === 'mL' ? 'Enter in mL — e.g. 10000 = 10 L' : '')}
                    onChange={(e) => { if (!editingProduct) setFormData({...formData, currentStock: parseFloat(e.target.value) || 0}); }}
                    readOnly={!!editingProduct}
                    min="0"
                    step="any"
                    style={editingProduct ? { opacity: 0.55, cursor: 'not-allowed', background: 'var(--input-bg)' } : {}}
                  />
                  {editingProduct
                    ? <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Read-only — use the Adjust button to change stock</div>
                    : <MlHelper value={formData.currentStock} unit={formData.unit} />
                  }
                </div>

                <div className="form-group">
                  <label>Min Stock Level {formData.unit === 'mL' ? '(mL)' : `(${formData.unit})`}</label>
                  <input
                    type="number"
                    className="input"
                    value={formData.minStockLevel}
                    onChange={(e) => setFormData({...formData, minStockLevel: parseFloat(e.target.value) || 0})}
                    min="0"
                    step="any"
                  />
                  <MlHelper value={formData.minStockLevel} unit={formData.unit} />
                  {editingProduct?.minStockAuto != null && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      Automatic minimum in use: {displayStock(editingProduct.minStockAuto, editingProduct.unit)} (Demand Planning safety stock).
                      This value only applies when the oil has no demand data.
                    </div>
                  )}
                </div>

                {formData.category === 'OILS' && (
                  <div className="form-group">
                    <label>Availability</label>
                    <select
                      className="input"
                      value={formData.exclusivity}
                      onChange={(e) => setFormData({...formData, exclusivity: e.target.value})}
                    >
                      <option value="SHARED">Shared by all</option>
                      <option value="MUSE">Muse platform — MUSE + Atelier</option>
                      <option value="SA">Scent Australia only</option>
                    </select>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      Who may consume this oil in production. <strong>Muse platform</strong> covers MUSE retail
                      <em> and </em> the Atelier — they are two units of the same business.
                      <strong> Scent Australia only</strong> is what keeps a client's Signature Fragrance out of Muse.
                      Doesn't affect Shopify.
                    </div>
                  </div>
                )}

                {/* A new oil is SA's unless unticked (S6). MUSE is registered with
                    Register afterwards: it needs a commercial name and who uses it. */}
                {fullLibrary && !editingProduct && (
                  <div className="form-group">
                    <label>Registration</label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, cursor: 'pointer' }}>
                      <input type="checkbox" checked={registerInSa} onChange={(e) => setRegisterInSa(e.target.checked)} />
                      Register in SA
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      For MUSE, use Register on the oil's row once it is created.
                    </div>
                  </div>
                )}

                {formData.category !== 'OILS' && (
                  <div className="form-group">
                    <label>Units per Box</label>
                    <input
                      type="number"
                      className="input"
                      value={formData.unitPerBox}
                      onChange={(e) => setFormData({...formData, unitPerBox: parseInt(e.target.value) || 1})}
                    />
                  </div>
                )}

                {formData.category !== 'OILS' && (
                  <div className="form-group">
                    <label>SKU Multipliers <span style={{fontWeight:'normal',fontSize:'0.8em',opacity:0.6}}>(optional — for products with multiple SKUs)</span></label>
                    <textarea
                      className="input"
                      rows={3}
                      style={{fontFamily:'monospace',fontSize:'0.85em'}}
                      placeholder={'{"SA_RM_00001": 12, "SA_RM_00002": 72}'}
                      value={Object.keys(formData.skuMultipliers || {}).length > 0
                        ? JSON.stringify(formData.skuMultipliers, null, 2)
                        : ''}
                      onChange={(e) => {
                        try {
                          const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                          setFormData({...formData, skuMultipliers: parsed});
                        } catch {
                          // keep raw value while user is still typing
                        }
                      }}
                    />
                  </div>
                )}

                <div className="form-group">
                  <label>Supplier</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.supplier}
                    onChange={(e) => setFormData({...formData, supplier: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Supplier Code</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.supplier_code}
                    onChange={(e) => setFormData({...formData, supplier_code: e.target.value})}
                  />
                </div>

                {/* Bin Location */}
                <BinLocationInput
                  category={formData.category}
                  value={formData.bin_location}
                  onChange={(value) => setFormData({...formData, bin_location: value})}
                />

                {/* A machine is not finished without these two, and until now they
                    existed only on the Diffusers screen — so registering one here
                    meant going there afterwards to complete it, and that round
                    trip is what overwrote a live SKU on 15 September. Both are
                    free text with the existing values suggested: the range grows,
                    and a fixed list would send the next new model back to the
                    other screen. The server has always accepted both. */}
                {formData.category === 'SCENT_MACHINES' && (
                  <>
                    <div className="form-group">
                      <label>Sub-category</label>
                      <input
                        type="text"
                        className="input"
                        list="machine-subcategories"
                        value={formData.sub_category}
                        onChange={(e) => setFormData({...formData, sub_category: e.target.value})}
                        placeholder="e.g. HVAC, Tower, ScentPRO"
                      />
                      <datalist id="machine-subcategories">
                        {[...new Set(products
                          .filter(p => p.category === 'SCENT_MACHINES' && p.sub_category)
                          .map(p => p.sub_category))].sort().map(s => <option key={s} value={s} />)}
                      </datalist>
                    </div>

                    <div className="form-group">
                      <label>Colour</label>
                      <input
                        type="text"
                        className="input"
                        list="machine-colours"
                        value={formData.color}
                        onChange={(e) => setFormData({...formData, color: e.target.value})}
                        placeholder="e.g. Black, White, Grey"
                      />
                      <datalist id="machine-colours">
                        {[...new Set(products
                          .filter(p => p.category === 'SCENT_MACHINES' && p.color)
                          .map(p => p.color))].sort().map(c => <option key={c} value={c} />)}
                      </datalist>
                    </div>
                  </>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingProduct ? 'Update Product' : 'Create Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Aliases Modal */}
      {showAliasModal && aliasProduct && (
        <div className="modal-overlay" onClick={() => setShowAliasModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <h2>Product Aliases</h2>
              <button className="modal-close" onClick={() => setShowAliasModal(false)}>×</button>
            </div>

            <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
              <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginBottom: '4px' }}>Product</div>
              <div style={{ fontWeight: '600' }}>{aliasProduct.name}</div>
              <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px', fontFamily: 'monospace' }}>
                {aliasProduct.productCode}
              </div>
            </div>

            <form onSubmit={handleAddAlias} style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  className="input"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  placeholder="Enter alternative name..."
                  style={{ flex: 1 }}
                />
                <button type="submit" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
                  + Add
                </button>
              </div>
            </form>

            <div style={{ minHeight: '60px' }}>
              {aliasLoading ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'rgba(232,234,242,0.45)' }}>
                  Loading...
                </div>
              ) : aliases.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'rgba(232,234,242,0.3)', fontSize: '14px' }}>
                  No aliases yet. Add alternative names above.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {aliases.map(alias => (
                    <div key={alias.id} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255,255,255,0.06)'
                    }}>
                      <span style={{ fontWeight: '500' }}>{alias.alias_name}</span>
                      <button
                        onClick={() => handleDeleteAlias(alias.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: '#ef4444',
                          fontSize: '18px',
                          lineHeight: 1,
                          padding: '0 4px'
                        }}
                        title="Remove alias"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowAliasModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {registerFor && (
        <RegisterFragranceModal
          product={registerFor}
          showToast={showToast}
          onClose={() => setRegisterFor(null)}
          onDone={(regs) => {
            // The row at once; the full list takes seconds to reload.
            patchRegistrations(registerFor.id, regs);
            setRegisterFor(null);
            fetchProducts();
          }}
        />
      )}

      {adjustFor && (
        <AdjustStockModal
          product={adjustFor}
          showToast={showToast}
          onClose={() => setAdjustFor(null)}
          onDone={(data) => {
            // The row at once, from the server's reply; the full list reloads after.
            setProducts((prev) => prev.map((p) => (p.id === adjustFor.id
              ? { ...p, currentStock: data.total, ...(data.sectors && { sectors: data.sectors, saStock: data.sectors.SA }) } : p)));
            setAdjustFor(null);
            fetchProducts();
          }}
        />
      )}

      {sheetFor && (
        <ProductSheet
          product={products.find((p) => p.id === sheetFor.id) || sheetFor}
          place={stockMode ? 'stock' : saView ? 'sa' : 'library'}
          actions={sheetActions(products.find((p) => p.id === sheetFor.id) || sheetFor)}
          onClose={() => setSheetFor(null)}
        />
      )}

      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

    </div>
  );
}
