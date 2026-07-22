import { useState, useEffect, useRef } from 'react';
import { useSearch } from 'wouter';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { displayStock } from '../utils/unitConversion';
import { exportProductsToExcel } from '../utils/excelExport';
import BinLocationInput from '../components/BinLocationInput';
import { GlowingEffect } from '../components/GlowingEffect';
import MlHelper from '../components/MlHelper';
import { LiquidMetalButton } from '../components/LiquidMetalButton';

export default function ProductManagement({ user }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [products, setProducts] = useState([]);
  const [filteredProducts, setFilteredProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [showInactive, setShowInactive]     = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showIncomingOnly, setShowIncomingOnly] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  // Incoming Orders states
  const [showIncomingModal, setShowIncomingModal] = useState(false);
  const [incomingProduct, setIncomingProduct] = useState(null);
  const [incomingFormData, setIncomingFormData] = useState({
    orderNumber: '',
    quantity: '',
    estimatedDeliveryDate: '',
    notes: ''
  });

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

  // Receive Orders states
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [receivingOrder, setReceivingOrder] = useState(null);
  const [receivingOption, setReceivingOption] = useState('full');
  const [receiveFormData, setReceiveFormData] = useState({
    quantityReceived: '',
    notes: ''
  });

  // PO Bulk Import states
  const poImportRef = useRef();
  const [showImportModal, setShowImportModal]   = useState(false);
  const [importPreviewing, setImportPreviewing] = useState(false);
  const [importConfirming, setImportConfirming] = useState(false);
  const [importPreview, setImportPreview]       = useState(null); // { preview: [], total }
  const [importChecked, setImportChecked]       = useState({});   // rowIndex → bool

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
    exclusivity: 'SHARED'
  });

  // D15: entering via the "Fragrance Library" tile lands here with
  // ?filter=OILS — a pure UI convenience, no new data path.
  const search = useSearch();
  useEffect(() => {
    const params = new URLSearchParams(search);
    const requestedFilter = params.get('filter');
    if (requestedFilter) setCategoryFilter(requestedFilter);
  }, [search]);

  useEffect(() => {
    fetchProducts();
  }, []);

  useEffect(() => {
    filterProducts();
  }, [products, categoryFilter, searchTerm, showIncomingOnly, showInactive]);

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
      const res = await fetch('/api/products');
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching products:', error);
      setLoading(false);
    }
  };

  const filterProducts = () => {
    let filtered = products;

    if (categoryFilter !== 'ALL') {
      filtered = filtered.filter(p => p.category === categoryFilter);
    }

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
        body: JSON.stringify({ ...formData, userId: user?.id || null })
      });

      if (res.ok) {
        showToast(editingProduct ? 'Product updated!' : 'Product created!', 'success');
        setShowAddModal(false);
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

  const handleClearIncoming = async (poId) => {
    if (!poId) { showToast('Cannot clear: order ID missing', 'error'); return; }
    setConfirmState({ message: 'Clear this incoming order?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/purchase-orders/${poId}?userId=${user?.id || ''}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Incoming order cleared!', 'success');
          fetchProducts();
        }
      } catch (error) {
        showToast('Error clearing incoming order: ' + error.message, 'error');
      }
    }});
  };

  const handleOpenIncomingModal = (product) => {
    setIncomingProduct(product);
    setIncomingFormData({
      orderNumber: '',
      quantity: '',
      estimatedDeliveryDate: '',
      notes: ''
    });
    setShowIncomingModal(true);
  };

  const handleAddIncoming = async (e) => {
    e.preventDefault();

    if (!incomingFormData.orderNumber || !incomingFormData.quantity) {
      showToast('Please fill in PO Number and Quantity', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/products/${incomingProduct.id}/incoming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: incomingFormData.orderNumber,
          quantity: parseFloat(incomingFormData.quantity),
          supplier: incomingProduct.supplier,
          notes: incomingFormData.notes,
          estimatedDeliveryDate: incomingFormData.estimatedDeliveryDate || null,
          addedBy: user?.username || user?.name || 'admin',
          userId: user?.id || null
        })
      });

      if (res.ok) {
        showToast('Incoming order added successfully!', 'success');
        setShowIncomingModal(false);
        setIncomingProduct(null);
        setIncomingFormData({ orderNumber: '', quantity: '', estimatedDeliveryDate: '', notes: '' });
        fetchProducts();
      } else {
        const error = await res.json();
        showToast(error.error || 'Error adding incoming order', 'error');
      }
    } catch (error) {
      showToast('Error adding incoming order: ' + error.message, 'error');
    }
  };

  const handleOpenReceiveModal = (product, order) => {
    if (!order.id) {
      showToast('Legacy order — clear it and re-add to receive stock', 'error');
      return;
    }
    setIncomingProduct(product);
    setReceivingOrder(order);
    setReceivingOption('full');
    setReceiveFormData({
      quantityReceived: order.quantity.toString(),
      notes: ''
    });
    setShowReceiveModal(true);
  };

  const handleReceiveIncoming = async (e) => {
    e.preventDefault();

    const quantityToReceive = receivingOption === 'full'
      ? receivingOrder.quantity
      : parseFloat(receiveFormData.quantityReceived);

    if (!quantityToReceive || quantityToReceive <= 0) {
      showToast('Please enter a valid quantity', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/purchase-orders/${receivingOrder.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantityReceived: quantityToReceive,
          notes: receiveFormData.notes || (receivingOption === 'full'
            ? 'Full quantity received'
            : `Partial quantity received: ${quantityToReceive} of ${receivingOrder.quantity}`),
          receivedBy: user?.username || 'admin',
          userId: user?.id || null
        })
      });

      if (res.ok) {
        const data = await res.json();
        const displayVal = incomingProduct.unit === 'mL' ? `${(data.newStock/1000).toFixed(3)} L` : `${data.newStock} ${incomingProduct.unit}`;
        showToast(`Stock updated successfully! New stock: ${displayVal}`, 'success');
        setShowReceiveModal(false);
        setIncomingProduct(null);
        setReceivingOrder(null);
        setReceivingOption('full');
        setReceiveFormData({ quantityReceived: '', notes: '' });
        fetchProducts();
      } else {
        const error = await res.json();
        showToast(error.error || 'Error receiving incoming order', 'error');
      }
    } catch (error) {
      showToast('Error receiving incoming order: ' + error.message, 'error');
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

  // ── PO Bulk Import handlers ──────────────────────────────────────────
  const handleDownloadTemplate = async () => {
    try {
      // Platform port: the fetch interceptor injects the Bearer token — the
      // manual header (old 'token' localStorage key) would override it with null.
      const res = await fetch('/api/po/template');
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'PO_Template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast('Error downloading template: ' + err.message, 'error');
    }
  };

  const handleImportFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setImportPreviewing(true);
    setImportPreview(null);
    setShowImportModal(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/po/import/preview', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview failed');
      setImportPreview(data);
      // Pre-check all importable rows
      const checked = {};
      data.preview.forEach(r => { if (r.importable) checked[r.rowIndex] = true; });
      setImportChecked(checked);
    } catch (err) {
      showToast('Import preview failed: ' + err.message, 'error');
      setShowImportModal(false);
    } finally {
      setImportPreviewing(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!importPreview) return;
    const toCreate = importPreview.preview
      .filter(r => importChecked[r.rowIndex] && r.importable)
      .map(r => ({
        productId:       r.matched.id,
        productName:     r.matched.name,
        productUnit:     r.matched.unit,
        productCategory: r.matched.category || '',
        productCode:     r.matched.productCode,
        poNumber:        r.poNumber,
        quantityMl:      r.quantityMl,
        etaRaw:          r.etaRaw,
        notes:           r.notes,
      }));
    if (toCreate.length === 0) { showToast('No valid rows selected', 'warning'); return; }
    setImportConfirming(true);
    try {
      const res = await fetch('/api/po/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toCreate, userId: user?.id || null, importedBy: user?.name || user?.username || 'import' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      showToast(`✅ ${data.created} PO${data.created !== 1 ? 's' : ''} created${data.skipped ? `, ${data.skipped} skipped (duplicates)` : ''}`, 'success');
      setShowImportModal(false);
      setImportPreview(null);
      setImportChecked({});
      fetchProducts();
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    } finally {
      setImportConfirming(false);
    }
  };

  const handleEdit = (product) => {
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
      exclusivity: product.exclusivity || 'SHARED'
    });
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({
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

  const getStockStatus = (product) => {
    if (product.currentStock === 0) {
      return { label: 'Out of Stock', color: 'red' };
    }
    if (product.currentStock < product.minStockLevel) {
      return { label: 'Low Stock', color: 'yellow' };
    }
    return { label: 'Healthy', color: 'green' };
  };

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
        <h2 className="page-title">Product Management</h2>
        <p style={{ color: 'rgba(232,234,242,0.45)', marginTop: '8px' }}>Manage all products across categories</p>
      </div>

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

        {['admin', 'root'].includes(user.role) && (
          <>
            <button
              className="btn"
              onClick={handleDownloadTemplate}
              style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.4)', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              📥 Download PO Template
            </button>
            <button
              className="btn"
              onClick={() => poImportRef.current?.click()}
              style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              📤 Import POs
            </button>
            <input ref={poImportRef} type="file" accept=".xlsx,.xls" onChange={handleImportFileSelect} style={{ display: 'none' }} />
          </>
        )}

        {/* Right-side group: BOM + Add Product */}
        <div style={{ display: 'flex', gap: 12, marginLeft: 'auto', alignItems: 'center' }}>
          <LiquidMetalButton label="🧩 BOM" width={108} onClick={() => window.location.href = '/sa/bom'} />
          {['admin', 'root'].includes(user.role) && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setEditingProduct(null);
                resetForm();
                setShowAddModal(true);
              }}
            >
              + Add Product
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
            {[
              { value: 'ALL', label: 'All' },
              { value: 'OILS', label: 'Oils' },
              { value: 'SA_SCENTED_PRODUCTS', label: 'Scented' },
              { value: 'SCENT_MACHINES', label: 'Diffuser Machines' },
              { value: 'MACHINES_SPARES', label: 'Spares' },
              { value: 'RAW_MATERIALS', label: 'Raw Materials' }
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
          </div>
        </div>
      </div>

      {/* Products Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Product Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Bin Location</th>
                <th>Stock</th>
                <th>Min Level</th>
                <th>Incoming Orders</th>
                <th>Supplier</th>
                <th>Supplier Code</th>
                {['admin', 'root'].includes(user.role) && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map(product => {
                const isNegative = product.currentStock < 0;
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
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{product.tag}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{product.productCode}</td>
                    <td style={{ fontWeight: '600' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {product.name}
                        {product.color && (
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
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${getCategoryBadge(product.category)}`}>
                        {getCategoryLabel(product.category)}
                      </span>
                    </td>
                    <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                      {product.bin_location || '-'}
                    </td>
                    <td>
                      <span style={{
                        fontWeight: isNegative ? '900' : 'normal',
                        color: isNegative ? '#dc2626' : 'inherit',
                        fontSize: isNegative ? '15px' : 'inherit'
                      }}>
                        {displayStock(product.currentStock, product.unit)}
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
                          ⚠️ {displayStock(Math.abs(product.currentStock), product.unit)} MISSING
                        </div>
                      )}
                    </td>
                    <td>{displayStock(product.minStockLevel, product.unit)}</td>
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
                                {['admin', 'root'].includes(user.role) && (
                                  <>
                                    <button
                                      onClick={() => handleOpenReceiveModal(product, order)}
                                      style={{
                                        background: '#10b981',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '11px',
                                        padding: '3px 8px',
                                        fontWeight: '600',
                                        marginLeft: 'auto'
                                      }}
                                      title="Mark as received"
                                    >
                                      ✓ Received
                                    </button>
                                    <button
                                      onClick={() => handleClearIncoming(order.id)}
                                      style={{
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontSize: '15px',
                                        color: '#ef4444',
                                        lineHeight: 1,
                                        padding: '0 2px'
                                      }}
                                      title="Clear incoming order"
                                    >
                                      ✕
                                    </button>
                                  </>
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
                          <button
                            className="btn"
                            onClick={() => handleOpenIncomingModal(product)}
                            style={{
                              fontSize: '12px',
                              padding: '6px 12px',
                              background: '#f59e0b',
                              color: 'white',
                              border: 'none'
                            }}
                            title="Add Incoming Order / Purchase Order"
                          >
                            + Incoming
                          </button>
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
              <h2>{editingProduct ? 'Edit Product' : 'Add New Product'}</h2>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>

            <form onSubmit={handleSubmit}>
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

                <div className="form-group">
                  <label>Category *</label>
                  <select
                    className="input"
                    value={formData.category}
                    onChange={(e) => setFormData({...formData, category: e.target.value, productCode: '', tag: ''})}
                    required
                  >
                    <option value="OILS">Oils</option>
                    <option value="SCENT_MACHINES">Diffuser Machines</option>
                    <option value="MACHINES_SPARES">Spares</option>
                    <option value="RAW_MATERIALS">Raw Materials</option>
                  </select>
                </div>

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
                      <option value="MUSE">MUSE only</option>
                      <option value="SM">SM only</option>
                    </select>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      Controls which businesses can use this oil in production (Fragrance Library). Doesn't affect Shopify.
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

      {/* Add Incoming Order Modal */}
      {showIncomingModal && incomingProduct && (
        <div className="modal-overlay" onClick={() => setShowIncomingModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Incoming Order - Purchase Order</h2>
              <button className="modal-close" onClick={() => setShowIncomingModal(false)}>×</button>
            </div>

            <form onSubmit={handleAddIncoming}>
              <div style={{ marginBottom: '20px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                <div style={{ fontWeight: '600', marginBottom: '4px' }}>Product:</div>
                <div style={{ fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>{incomingProduct.name}</div>
                <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px' }}>
                  Tag: {incomingProduct.tag} | Code: {incomingProduct.productCode}
                </div>
                {incomingProduct.supplier && (
                  <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px' }}>
                    Supplier: {incomingProduct.supplier}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label>PO Number / Order Number *</label>
                <input
                  type="text"
                  className="input"
                  value={incomingFormData.orderNumber}
                  onChange={(e) => setIncomingFormData({...incomingFormData, orderNumber: e.target.value})}
                  placeholder="e.g., #PO166"
                  required
                />
                <small style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginTop: '4px', display: 'block' }}>
                  Same PO number as in Shopify Purchase Order
                </small>
              </div>

              <div className="form-group">
                <label>Quantity * {incomingProduct.unit === 'mL' ? '(mL)' : `(${incomingProduct.unit})`}</label>
                <input
                  type="number"
                  className="input"
                  value={incomingFormData.quantity}
                  onChange={(e) => setIncomingFormData({...incomingFormData, quantity: e.target.value})}
                  placeholder={incomingProduct.unit === 'mL' ? 'e.g. 10000 = 10 L' : 'e.g. 10'}
                  min="0"
                  step="any"
                  required
                />
                <MlHelper value={incomingFormData.quantity} unit={incomingProduct.unit} />
              </div>

              <div className="form-group">
                <label>Estimated Time of Arrival (ETA)</label>
                <input
                  type="date"
                  className="input"
                  value={incomingFormData.estimatedDeliveryDate}
                  onChange={(e) => setIncomingFormData({...incomingFormData, estimatedDeliveryDate: e.target.value})}
                />
                <small style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginTop: '4px', display: 'block' }}>
                  Expected date for the stock to arrive (Estimated Time of Arrival)
                </small>
              </div>

              <div className="form-group">
                <label>Notes (Optional)</label>
                <textarea
                  className="input"
                  value={incomingFormData.notes}
                  onChange={(e) => setIncomingFormData({...incomingFormData, notes: e.target.value})}
                  placeholder="e.g., Wilmar BioEthanol, special handling required"
                  rows="3"
                />
              </div>

              {/* Auto-recorded info */}
              <div style={{
                padding: '10px 14px',
                background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.2)',
                borderRadius: '8px',
                marginBottom: '16px',
                fontSize: '12px',
                color: 'rgba(232,234,242,0.55)'
              }}>
                <span style={{ color: '#a5b4fc', fontWeight: '600' }}>Auto-recorded: </span>
                Created by <strong style={{ color: 'rgba(232,234,242,0.8)' }}>{user?.username || user?.name || 'admin'}</strong> on {new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>

              <div style={{
                padding: '12px',
                background: 'rgba(251,191,36,0.08)',
                borderRadius: '8px',
                marginBottom: '20px',
                fontSize: '13px',
                color: '#fbbf24'
              }}>
                <strong>💡 Reminder:</strong> After creating the PO in Shopify, add it here to track incoming stock.
                When you receive the goods and click "Receive inventory" in Shopify, update the stock in ScentSystem via Stock Management.
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowIncomingModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Incoming Order
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

      {/* Receive Incoming Order Modal */}
      {showReceiveModal && incomingProduct && receivingOrder && (
        <div className="modal-overlay" onClick={() => { setShowReceiveModal(false); setReceivingOrder(null); setIncomingProduct(null); setReceivingOption('full'); setReceiveFormData({ quantityReceived: '', notes: '' }); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Receive Purchase Order</h2>
              <button className="modal-close" onClick={() => { setShowReceiveModal(false); setReceivingOrder(null); setIncomingProduct(null); setReceivingOption('full'); setReceiveFormData({ quantityReceived: '', notes: '' }); }}>×</button>
            </div>

            <form onSubmit={handleReceiveIncoming}>
              <div style={{ marginBottom: '20px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                <div style={{ fontWeight: '600', marginBottom: '4px' }}>Product:</div>
                <div style={{ fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>{incomingProduct.name}</div>
                <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px' }}>
                  PO Number: {receivingOrder.orderNumber}
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px' }}>
                  Expected Quantity: {displayStock(receivingOrder.quantity, incomingProduct.unit)}
                </div>
              </div>

              <div className="form-group">
                <label style={{ fontWeight: '600', marginBottom: '12px', display: 'block' }}>
                  Did you receive the full quantity?
                </label>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '12px',
                    border: receivingOption === 'full' ? '2px solid #10b981' : '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: receivingOption === 'full' ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.04)'
                  }}>
                    <input
                      type="radio"
                      name="receivingOption"
                      value="full"
                      checked={receivingOption === 'full'}
                      onChange={(e) => setReceivingOption(e.target.value)}
                      style={{ marginRight: '8px' }}
                    />
                    <span style={{ fontWeight: receivingOption === 'full' ? '600' : '400' }}>
                      Yes, I received {displayStock(receivingOrder.quantity, incomingProduct.unit)} in full
                    </span>
                  </label>

                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '12px',
                    border: receivingOption === 'partial' ? '2px solid #f59e0b' : '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: receivingOption === 'partial' ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.04)'
                  }}>
                    <input
                      type="radio"
                      name="receivingOption"
                      value="partial"
                      checked={receivingOption === 'partial'}
                      onChange={(e) => setReceivingOption(e.target.value)}
                      style={{ marginRight: '8px' }}
                    />
                    <span style={{ fontWeight: receivingOption === 'partial' ? '600' : '400' }}>
                      No, I received a different quantity
                    </span>
                  </label>
                </div>
              </div>

              {receivingOption === 'partial' && (
                <div className="form-group">
                  <label>Quantity Received *</label>
                  <input
                    type="number"
                    className="input"
                    value={receiveFormData.quantityReceived}
                    onChange={(e) => setReceiveFormData({...receiveFormData, quantityReceived: e.target.value})}
                    placeholder={`e.g., ${receivingOrder.quantity}`}
                    min="0"
                    step="any"
                    required
                  />
                  <small style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginTop: '4px', display: 'block' }}>
                    Units: {incomingProduct.unit}{incomingProduct.unit === 'mL' ? ' (enter in mL, e.g. 10000 = 10 L)' : ''}
                  </small>
                </div>
              )}

              <div className="form-group">
                <label>Notes (Optional)</label>
                <textarea
                  className="input"
                  value={receiveFormData.notes}
                  onChange={(e) => setReceiveFormData({...receiveFormData, notes: e.target.value})}
                  placeholder="e.g., Received in good condition"
                  rows="3"
                />
              </div>

              <div style={{
                padding: '12px',
                background: 'rgba(34,197,94,0.08)',
                borderRadius: '8px',
                marginBottom: '20px',
                fontSize: '13px',
                color: '#10b981',
                border: '1px solid #10b981'
              }}>
                <strong>✓ Automatic Actions:</strong>
                <ul style={{ margin: '8px 0 0 20px', padding: 0 }}>
                  <li>Stock will be updated automatically (+{receivingOption === 'full' ? receivingOrder.quantity : receiveFormData.quantityReceived || '___'} {incomingProduct.unit})</li>
                  <li>Transaction will be created in History</li>
                  <li>Incoming order badge will be removed</li>
                </ul>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowReceiveModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ background: '#10b981', borderColor: '#10b981' }}>
                  Confirm & Update Stock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {/* ── PO Bulk Import Review Modal ── */}
      {showImportModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#0e0e1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, width: '100%', maxWidth: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 60px rgba(0,0,0,0.6)' }}>

            {/* Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#e2e8f0' }}>📤 PO Import — Review</h2>
                {importPreview && (
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(232,234,242,0.45)' }}>
                    {importPreview.total} rows read from file ·{' '}
                    <span style={{ color: '#4ade80' }}>{importPreview.preview.filter(r => r.importable).length} ready</span> ·{' '}
                    <span style={{ color: '#f87171' }}>{importPreview.preview.filter(r => r.status === 'not_found').length} not found</span> ·{' '}
                    <span style={{ color: '#fbbf24' }}>{importPreview.preview.filter(r => r.status === 'duplicate').length} duplicate</span>
                  </p>
                )}
              </div>
              <button onClick={() => { setShowImportModal(false); setImportPreview(null); setImportChecked({}); }}
                style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 8, color: '#e2e8f0', fontSize: 18, cursor: 'pointer', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>

            {/* Body */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '0 0 8px' }}>
              {importPreviewing ? (
                <div style={{ textAlign: 'center', padding: 48, color: 'rgba(232,234,242,0.4)' }}>⏳ Reading file...</div>
              ) : importPreview ? (
                <>
                  {/* Legend */}
                  <div style={{ display: 'flex', gap: 16, padding: '12px 24px', fontSize: 11, color: 'rgba(232,234,242,0.45)', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
                    <span>✅ Matched — ready to import</span>
                    <span>⚠️ Name differs — still importable</span>
                    <span>🔁 Duplicate — already exists, will skip</span>
                    <span>❌ Not found — must be added manually</span>
                  </div>

                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.04)', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px 16px', textAlign: 'center', color: '#94a3b8', fontWeight: 600, width: 40 }}>
                          <input type="checkbox"
                            checked={importPreview.preview.filter(r => r.importable).every(r => importChecked[r.rowIndex])}
                            onChange={e => {
                              const next = { ...importChecked };
                              importPreview.preview.filter(r => r.importable).forEach(r => { next[r.rowIndex] = e.target.checked; });
                              setImportChecked(next);
                            }}
                          />
                        </th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Status</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Product Code / Tag</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Matched Product</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>PO Number</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: '#94a3b8', fontWeight: 600 }}>Qty (mL → L)</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>ETA</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#94a3b8', fontWeight: 600 }}>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.preview.map(row => {
                        const statusMap = {
                          matched:      { icon: '✅', color: '#4ade80',  bg: 'transparent' },
                          name_mismatch:{ icon: '⚠️', color: '#fbbf24',  bg: 'rgba(251,191,36,0.04)' },
                          duplicate:    { icon: '🔁', color: '#60a5fa',  bg: 'rgba(37,99,235,0.04)' },
                          not_found:    { icon: '❌', color: '#f87171',  bg: 'rgba(220,38,38,0.06)' },
                          error:        { icon: '🚫', color: '#f87171',  bg: 'rgba(220,38,38,0.08)' },
                        };
                        const s = statusMap[row.status] || statusMap.error;
                        const canCheck = row.importable;

                        return (
                          <tr key={row.rowIndex} style={{ background: s.bg, borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: !canCheck ? 0.55 : 1 }}>
                            <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                              {canCheck
                                ? <input type="checkbox" checked={!!importChecked[row.rowIndex]} onChange={e => setImportChecked(prev => ({ ...prev, [row.rowIndex]: e.target.checked }))} />
                                : <span style={{ fontSize: 10, color: 'rgba(232,234,242,0.2)' }}>—</span>}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{s.icon} {row.status.replace('_', ' ')}</span>
                              {row.errors.length > 0 && <div style={{ fontSize: 10, color: '#f87171', marginTop: 2 }}>{row.errors.join(', ')}</div>}
                              {row.nameMismatch && <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 2 }}>Name in file: "{row.rawName}"</div>}
                              {row.isDuplicate && <div style={{ fontSize: 10, color: '#60a5fa', marginTop: 2 }}>PO already exists</div>}
                            </td>
                            <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 11, color: '#93c5fd' }}>
                              {row.rawCode && <div>{row.rawCode}</div>}
                              {row.rawTag && <div style={{ color: 'rgba(232,234,242,0.4)' }}>{row.rawTag}</div>}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              {row.matched
                                ? <><div style={{ fontWeight: 600, color: '#e2e8f0' }}>{row.matched.name}</div><div style={{ fontSize: 10, color: 'rgba(232,234,242,0.4)' }}>{row.matched.productCode}</div></>
                                : <span style={{ color: '#f87171', fontStyle: 'italic' }}>No match found</span>}
                            </td>
                            <td style={{ padding: '10px 12px', fontWeight: 700, color: '#fbbf24' }}>{row.poNumber || '—'}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#e2e8f0' }}>
                              {row.quantityMl != null
                                ? <><span>{row.quantityMl.toLocaleString()} mL</span><span style={{ color: '#60a5fa', marginLeft: 6 }}>= {(row.quantityMl / 1000).toFixed(3)} L</span></>
                                : <span style={{ color: '#f87171' }}>—</span>}
                            </td>
                            <td style={{ padding: '10px 12px', color: '#10b981' }}>{row.etaRaw || <span style={{ color: 'rgba(232,234,242,0.25)' }}>—</span>}</td>
                            <td style={{ padding: '10px 12px', color: 'rgba(232,234,242,0.45)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.notes || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              ) : null}
            </div>

            {/* Footer */}
            {importPreview && (
              <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, gap: 12 }}>
                <div style={{ fontSize: 12, color: 'rgba(232,234,242,0.45)' }}>
                  <strong style={{ color: '#4ade80' }}>{Object.values(importChecked).filter(Boolean).length}</strong> selected for import
                  {importPreview.preview.filter(r => r.status === 'not_found').length > 0 && (
                    <span style={{ marginLeft: 16, color: '#f87171' }}>
                      ⚠️ {importPreview.preview.filter(r => r.status === 'not_found').length} product(s) not found — add them to the system first, then re-import
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => { setShowImportModal(false); setImportPreview(null); setImportChecked({}); }}
                    className="btn" style={{ background: 'rgba(255,255,255,0.06)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.12)' }}>
                    Cancel
                  </button>
                  <button onClick={handleConfirmImport} disabled={importConfirming || Object.values(importChecked).filter(Boolean).length === 0}
                    className="btn" style={{ background: '#10b981', color: 'white', border: 'none', opacity: importConfirming ? 0.7 : 1, cursor: importConfirming ? 'not-allowed' : 'pointer' }}>
                    {importConfirming ? '⏳ Importing...' : `✅ Import ${Object.values(importChecked).filter(Boolean).length} PO${Object.values(importChecked).filter(Boolean).length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
