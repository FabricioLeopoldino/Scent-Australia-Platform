import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';

export default function ScentedProducts({ user }) {
  const showToast = useToast();
  const isRoot  = user?.role === 'root';
  const isAdmin = ['admin', 'root'].includes(user?.role);

  const [activeTab, setActiveTab] = useState('products');
  const [loading, setLoading]     = useState(true);
  const [confirmState, setConfirmState] = useState(null);

  // shared data
  const [containers, setContainers]   = useState([]); // each has .bom[] embedded
  const [groups, setGroups]           = useState([]); // each has .products[] embedded
  const [oilProducts, setOilProducts] = useState([]);
  const [rawMaterials, setRawMaterials] = useState([]);
  const [shopifyStatuses, setShopifyStatuses] = useState({});
  const [shopifyEnabled, setShopifyEnabled]   = useState(false);
  const [publishing, setPublishing]   = useState({}); // { [productId]: true }

  // container management state
  const [selectedContainerId, setSelectedContainerId]     = useState(null);
  const [highlightedContainerId, setHighlightedContainerId] = useState(null);
  const [showAddContainerModal, setShowAddContainerModal] = useState(false);
  const [showEditContainerModal, setShowEditContainerModal] = useState(false);
  const [editingContainer, setEditingContainer]           = useState(null);
  const [containerForm, setContainerForm] = useState({ name: '', skuPrefix: '', volumeMl: '', price: '', notes: '' });
  const [showBomModal, setShowBomModal]   = useState(false);
  const [editingBomItem, setEditingBomItem] = useState(null);
  const [bomForm, setBomForm] = useState({ componentCode: '', componentName: '', quantity: '', unit: 'mL', isFragrance: false });

  // product groups state
  const [expandedGroup, setExpandedGroup]             = useState(null);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [groupForm, setGroupForm] = useState({
    groupName: '', fragranceProductId: '', containerIds: [],
    fragranceDescription: '', fragranceType: '', fragranceNotes: '',
  });
  const [savingGroup, setSavingGroup] = useState(false);
  const [fragranceSearch, setFragranceSearch] = useState('');
  const [fragranceDropdownOpen, setFragranceDropdownOpen] = useState(false);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    console.log('[ScentedProducts] fetchAll start');
    setLoading(true);

    const fetchOne = async (url, label) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res.ok) {
          console.warn(`[ScentedProducts] ${label} returned ${res.status}:`, data);
          return null;
        }
        console.log(`[ScentedProducts] ${label} OK`, Array.isArray(data) ? `(${data.length} rows)` : '');
        return data;
      } catch (e) {
        console.error(`[ScentedProducts] ${label} fetch failed:`, e?.message || e);
        return null;
      }
    };

    try {
      const [cData, gData, pData] = await Promise.all([
        fetchOne('/api/scented-containers',      'scented-containers'),
        fetchOne('/api/scented-product-groups',  'scented-product-groups'),
        fetchOne('/api/products',                'products'),
      ]);

      setContainers(Array.isArray(cData) ? cData : []);
      setGroups(Array.isArray(gData) ? gData : []);
      const allP = Array.isArray(pData) ? pData : [];
      setRawMaterials(allP.filter(p => p.category === 'RAW_MATERIALS'));
      setOilProducts(allP.filter(p => p.category === 'OILS'));

      if (cData === null && gData === null && pData === null) {
        showToast('All API calls failed — check console (F12)', 'error');
      } else if (cData === null || gData === null) {
        showToast('Some scented endpoints failed — check console (F12)', 'warning');
      }
    } catch (err) {
      console.error('[ScentedProducts] fetchAll outer error:', err);
      showToast('Failed to load data', 'error');
    } finally {
      console.log('[ScentedProducts] fetchAll done — setLoading(false)');
      setLoading(false);
    }
    // Shopify status — non-blocking
    try {
      const sRes = await fetch('/api/shopify/status');
      if (sRes.ok) {
        const sData = await sRes.json();
        setShopifyEnabled(!!sData.enabled);
        setShopifyStatuses(sData.statuses || {});
      }
    } catch { /* optional */ }
  };

  const fetchShopifyStatuses = async () => {
    try {
      const sRes = await fetch('/api/shopify/status');
      if (sRes.ok) {
        const sData = await sRes.json();
        setShopifyEnabled(!!sData.enabled);
        setShopifyStatuses(sData.statuses || {});
      }
    } catch { /* optional */ }
  };

  const getShopifyBadge = (product) => {
    if (!shopifyEnabled) return null;
    const skus = product.shopifySkus && typeof product.shopifySkus === 'object' ? Object.values(product.shopifySkus) : [];
    if (skus.length === 0) return null;
    const status = skus.map(sku => shopifyStatuses[sku]?.status).find(Boolean);
    const cfg = {
      active:   { label: 'Active',   color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)' },
      draft:    { label: 'Draft',    color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
      archived: { label: 'Archived', color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.3)' },
    };
    if (!status) {
      return (
        <span style={{
          fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '12px',
          color: '#94a3b8', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)',
        }}>
          Not Published
        </span>
      );
    }
    const c = cfg[status] || cfg.draft;
    return (
      <span style={{
        fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '12px',
        color: c.color, background: c.bg, border: `1px solid ${c.border}`,
      }}>
        {c.label}
      </span>
    );
  };

  // ── helpers ────────────────────────────────────────────────────────────────

  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return v;
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
  };

  const updateContainerBom = (containerId, fn) =>
    setContainers(prev => prev.map(c =>
      c.id === containerId ? { ...c, bom: fn(c.bom || []) } : c
    ));

  const getStockBadge = (product) => {
    const stock = parseFloat(product.currentStock ?? 0);
    const min   = parseFloat(product.minStockLevel ?? 0);
    if (stock <= 0)   return { label: 'Out of Stock', cls: 'badge-danger' };
    if (stock <= min) return { label: 'Low Stock',    cls: 'badge-warning' };
    return               { label: 'In Stock',      cls: 'badge-success' };
  };

  // ── Container CRUD ─────────────────────────────────────────────────────────

  const handleAddContainer = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/scented-containers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:       containerForm.name,
          sku_prefix: containerForm.skuPrefix,
          volume_ml:  containerForm.volumeMl || null,
          price:      containerForm.price !== '' ? containerForm.price : null,
          notes:      containerForm.notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'Error', 'error');
      setContainers(prev => [...prev, { ...data, bom: [] }]);
      setShowAddContainerModal(false);
      resetContainerForm();
      showToast('Container added — configure its BOM next!', 'success');
      // Highlight the newly-created container for ~6s and auto-scroll into view
      setHighlightedContainerId(data.id);
      setTimeout(() => setHighlightedContainerId(curr => curr === data.id ? null : curr), 6000);
      setTimeout(() => {
        const el = document.querySelector(`[data-container-id="${data.id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    } catch { showToast('Error adding container', 'error'); }
  };

  const handleEditContainer = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/scented-containers/${editingContainer.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:      containerForm.name,
          volume_ml: containerForm.volumeMl || null,
          price:     containerForm.price !== '' ? containerForm.price : null,
          notes:     containerForm.notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'Error', 'error');
      setContainers(prev => prev.map(c =>
        c.id === editingContainer.id ? { ...data, bom: c.bom } : c
      ));
      setShowEditContainerModal(false);
      setEditingContainer(null);
      resetContainerForm();
      showToast('Container updated', 'success');
    } catch { showToast('Error updating container', 'error'); }
  };

  const handleDeleteContainer = (id, name) => {
    setConfirmState({
      message: `Delete container "${name}"? This will also delete its BOM template.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/scented-containers/${id}`, { method: 'DELETE' });
          if (!res.ok) { const d = await res.json(); return showToast(d.error || 'Error', 'error'); }
          setContainers(prev => prev.filter(c => c.id !== id));
          if (selectedContainerId === id) setSelectedContainerId(null);
          showToast('Container deleted', 'success');
        } catch { showToast('Error deleting container', 'error'); }
      },
    });
  };

  const openEditContainer = (c) => {
    setEditingContainer(c);
    setContainerForm({
      name: c.name,
      skuPrefix: c.sku_prefix,
      volumeMl: fmt(c.volume_ml),
      price: c.price != null ? String(parseFloat(c.price)) : '',
      notes: c.notes || '',
    });
    setShowEditContainerModal(true);
  };

  const resetContainerForm = () =>
    setContainerForm({ name: '', skuPrefix: '', volumeMl: '', price: '', notes: '' });

  // ── Container BOM CRUD ─────────────────────────────────────────────────────

  const handleSaveBomRow = async (e) => {
    e.preventDefault();
    const cid = selectedContainerId;
    if (!bomForm.isFragrance && !bomForm.componentCode) return showToast('Enter a component code', 'error');
    if (!bomForm.quantity) return showToast('Quantity is required', 'error');

    if (editingBomItem) {
      try {
        const res = await fetch(`/api/scented-containers/${cid}/bom/${editingBomItem.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            component_name: bomForm.componentName || null,
            quantity:       parseFloat(bomForm.quantity),
            unit:           bomForm.unit,
          }),
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Error', 'error');
        updateContainerBom(cid, bom => bom.map(r => r.id === editingBomItem.id ? data : r));
        closeBomModal();
        showToast('Component updated', 'success');
      } catch { showToast('Error updating component', 'error'); }
    } else {
      try {
        const res = await fetch(`/api/scented-containers/${cid}/bom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            component_code: bomForm.isFragrance ? 'FRAGRANCE_PLACEHOLDER' : bomForm.componentCode,
            component_name: bomForm.componentName || null,
            quantity:       parseFloat(bomForm.quantity),
            unit:           bomForm.unit,
            is_fragrance:   bomForm.isFragrance,
          }),
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Error', 'error');
        updateContainerBom(cid, bom => [...bom, data]);
        closeBomModal();
        showToast('Component added', 'success');
      } catch { showToast('Error adding component', 'error'); }
    }
  };

  const handleDeleteBomRow = (rowId) => {
    const cid = selectedContainerId;
    setConfirmState({
      message: 'Remove this component from the container BOM template?',
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/scented-containers/${cid}/bom/${rowId}`, { method: 'DELETE' });
          if (!res.ok) { const d = await res.json(); return showToast(d.error || 'Error', 'error'); }
          updateContainerBom(cid, bom => bom.filter(r => r.id !== rowId));
          showToast('Component removed', 'success');
        } catch { showToast('Error removing component', 'error'); }
      },
    });
  };

  const openAddBomRow = () => {
    setEditingBomItem(null);
    setBomForm({ componentCode: '', componentName: '', quantity: '', unit: 'mL', isFragrance: false });
    setShowBomModal(true);
  };

  const openEditBomRow = (item) => {
    setEditingBomItem(item);
    setBomForm({
      componentCode: item.is_fragrance ? '' : (item.component_code || ''),
      componentName: item.component_name || '',
      quantity:      fmt(item.quantity),
      unit:          item.unit || 'mL',
      isFragrance:   item.is_fragrance || false,
    });
    setShowBomModal(true);
  };

  const closeBomModal = () => {
    setShowBomModal(false);
    setEditingBomItem(null);
    setBomForm({ componentCode: '', componentName: '', quantity: '', unit: 'mL', isFragrance: false });
  };

  const handleRmSelect = (e) => {
    const rm = rawMaterials.find(r => r.productCode === e.target.value);
    if (rm) setBomForm(p => ({ ...p, componentCode: rm.productCode, componentName: rm.name }));
  };

  // ── Product Groups ─────────────────────────────────────────────────────────

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!groupForm.groupName.trim())        return showToast('Enter a line name', 'error');
    if (!groupForm.fragranceProductId)       return showToast('Select a fragrance oil', 'error');
    if (groupForm.containerIds.length === 0) return showToast('Select at least one container', 'error');
    setSavingGroup(true);
    try {
      const res = await fetch('/api/scented-product-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_name:            groupForm.groupName,
          fragrance_product_id:  groupForm.fragranceProductId,
          container_ids:         groupForm.containerIds,
          fragrance_description: groupForm.fragranceDescription,
          fragrance_type:        groupForm.fragranceType,
          fragrance_notes:       groupForm.fragranceNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'Error creating line', 'error');
      showToast(`${groupForm.groupName} line created!`, 'success');
      setShowCreateGroupModal(false);
      setGroupForm({
        groupName: '', fragranceProductId: '', containerIds: [],
        fragranceDescription: '', fragranceType: '', fragranceNotes: '',
      });
      setFragranceSearch('');
      fetchAll();
    } catch { showToast('Error creating line', 'error'); }
    finally { setSavingGroup(false); }
  };

  const [deleteGroupTarget, setDeleteGroupTarget] = useState(null);

  const handleDeleteGroup = (id, name) => {
    setDeleteGroupTarget({ id, name });
  };

  const doDeleteGroup = async (cascade) => {
    const target = deleteGroupTarget;
    if (!target) return;
    setDeleteGroupTarget(null);
    try {
      const res = await fetch(`/api/scented-product-groups/${target.id}?cascade=${cascade}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); return showToast(d.error || 'Error', 'error'); }
      setGroups(prev => prev.filter(g => g.id !== target.id));
      showToast(cascade ? 'Group and all products deleted' : 'Group deleted (products kept)', 'success');
    } catch { showToast('Error deleting group', 'error'); }
  };

  const handleDeleteProduct = (product, groupId) => {
    setConfirmState({
      message: `Delete product "${product.productCode} — ${product.name}"? This removes the product, its BOM, and stock transactions. Cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/products/${product.id}?userId=${user?.id || ''}`, { method: 'DELETE' });
          if (!res.ok) { const d = await res.json(); return showToast(d.error || 'Error deleting product', 'error'); }
          setGroups(prev => prev.map(g =>
            g.id === groupId ? { ...g, products: (g.products || []).filter(p => p.id !== product.id) } : g
          ));
          showToast(`${product.productCode} deleted`, 'success');
        } catch { showToast('Error deleting product', 'error'); }
      },
    });
  };

  const handlePublish = async (productId, productName) => {
    setPublishing(prev => ({ ...prev, [productId]: true }));
    try {
      const res = await fetch(`/api/shopify/publish/${productId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id }),
      });
      const data = await res.json();
      if (res.ok && data.added > 0) {
        showToast(`${productName} published to Shopify`, 'success');
        await fetchShopifyStatuses();
      } else if (res.ok) {
        showToast(`${productName}: already published or no SKUs configured`, 'info');
      } else {
        showToast(data.error || 'Failed to publish', 'error');
      }
    } catch { showToast('Error publishing to Shopify', 'error'); }
    finally {
      setPublishing(prev => ({ ...prev, [productId]: false }));
    }
  };

  const previewSkus = () =>
    groupForm.containerIds
      .map(cid => containers.find(c => c.id === cid))
      .filter(Boolean)
      .map(c => ({ container: c.name, sku: `${c.sku_prefix}_XXXXX` }));

  // ── derived ────────────────────────────────────────────────────────────────

  const selectedContainer = containers.find(c => c.id === selectedContainerId);
  const selectedBomRows   = selectedContainer?.bom || [];

  // ── render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">SA SCENTED PRODUCTS</h2>
          <p>Manage scented product lines and container BOM templates</p>
        </div>
        {isAdmin && activeTab === 'products' && (
          <button className="btn btn-primary" onClick={() => setShowCreateGroupModal(true)}>
            + New Scented Line
          </button>
        )}
        {isRoot && activeTab === 'containers' && (
          <button className="btn btn-primary" onClick={() => { resetContainerForm(); setShowAddContainerModal(true); }}>
            + Add Container
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '1px solid var(--border)' }}>
        {[
          { key: 'products',   label: 'Products' },
          { key: 'shopify',    label: 'Shopify Status' },
          { key: 'containers', label: 'Container Management' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            background: 'none', border: 'none',
            borderBottom: activeTab === tab.key ? '2px solid #6366f1' : '2px solid transparent',
            color:      activeTab === tab.key ? '#6366f1' : 'rgba(232,234,242,0.5)',
            fontWeight: activeTab === tab.key ? '700' : '500',
            fontSize: '14px', padding: '10px 20px', cursor: 'pointer',
            fontFamily: 'Inter, sans-serif', transition: 'all 0.2s', marginBottom: '-1px',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════ TAB 1: PRODUCTS ════════════════════════════ */}
      {activeTab === 'products' && (
        <div>
          {groups.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '60px', position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
              <p style={{ fontSize: '16px', color: 'rgba(232,234,242,0.4)', marginBottom: '16px' }}>
                No scented lines yet
              </p>
              {isAdmin && (
                <button className="btn btn-primary" onClick={() => setShowCreateGroupModal(true)}>
                  + New Scented Line
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {groups.map(group => {
                const isExpanded = expandedGroup === group.id;
                const prods = Array.isArray(group.products) ? group.products : [];
                return (
                  <div key={group.id} className="card" style={{ position: 'relative', overflow: 'visible' }}>
                    <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

                    {/* Group header row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <button
                          onClick={() => setExpandedGroup(prev => prev === group.id ? null : group.id)}
                          style={{
                            background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
                            borderRadius: '8px', width: '32px', height: '32px', display: 'flex',
                            alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                            color: '#6366f1', fontSize: '13px', transition: 'all 0.2s', flexShrink: 0,
                          }}
                        >
                          {isExpanded ? '▲' : '▼'}
                        </button>
                        <div>
                          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700' }}>{group.group_name}</h3>
                          <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginTop: '3px' }}>
                            {prods.length} product{prods.length !== 1 ? 's' : ''}
                            {group.fragrance_name && (
                              <> · Fragrance: <strong style={{ color: '#a5b4fc' }}>{group.fragrance_name}</strong></>
                            )}
                            {' · '}Created {new Date(group.created_at).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      {isAdmin && (
                        <button
                          className="btn btn-danger"
                          onClick={() => handleDeleteGroup(group.id, group.group_name)}
                          style={{ fontSize: '12px', padding: '4px 12px' }}
                        >
                          Delete
                        </button>
                      )}
                    </div>

                    {/* Expanded products list */}
                    {isExpanded && (
                      <div style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                        {prods.length === 0 ? (
                          <p style={{ color: 'rgba(232,234,242,0.35)', fontSize: '13px', textAlign: 'center' }}>
                            No products in this group
                          </p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {prods.map(product => {
                              const badge = getStockBadge(product);
                              const skus = product.shopifySkus && typeof product.shopifySkus === 'object' ? Object.values(product.shopifySkus) : [];
                              const isPublished = skus.some(sku => !!shopifyStatuses[sku]);
                              return (
                                <div key={product.id} style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
                                  borderRadius: '8px', padding: '10px 16px', flexWrap: 'wrap', gap: '10px',
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '200px' }}>
                                    <span style={{
                                      fontFamily: 'monospace', fontSize: '12px', fontWeight: '700',
                                      color: '#93c5fd', background: 'rgba(147,197,253,0.08)',
                                      padding: '3px 8px', borderRadius: '4px',
                                    }}>
                                      {product.productCode}
                                    </span>
                                    <span style={{ fontWeight: '600', fontSize: '14px' }}>{product.name}</span>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                                    <span style={{ fontSize: '13px', color: 'rgba(232,234,242,0.6)' }}>
                                      Stock: <strong style={{ color: '#e8eaf2' }}>{product.currentStock ?? 0}</strong>
                                    </span>
                                    <span className={`badge ${badge.cls}`} style={{ fontSize: '11px', padding: '2px 8px', fontWeight: '700' }}>
                                      {badge.label}
                                    </span>
                                    {getShopifyBadge(product)}
                                    {isAdmin && !isPublished && (
                                      <button
                                        className="btn btn-secondary"
                                        onClick={() => handlePublish(product.id, product.name)}
                                        disabled={!!publishing[product.id]}
                                        style={{ fontSize: '12px', padding: '4px 12px', opacity: publishing[product.id] ? 0.6 : 1 }}
                                      >
                                        {publishing[product.id] ? 'Publishing…' : 'Publish to Shopify'}
                                      </button>
                                    )}
                                    {isAdmin && (
                                      <button
                                        className="btn btn-danger"
                                        onClick={() => handleDeleteProduct(product, group.id)}
                                        style={{ fontSize: '12px', padding: '4px 12px' }}
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═════════════════════ TAB: SHOPIFY STATUS ══════════════════════ */}
      {activeTab === 'shopify' && (
        <div>
          <div className="card" style={{ marginBottom: '16px', position: 'relative', overflow: 'visible' }}>
            <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Shopify Publication Status</h3>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'rgba(232,234,242,0.5)' }}>
                  {shopifyEnabled
                    ? 'Live status of all scented products in your Shopify store'
                    : 'Shopify credentials not configured — status unavailable'}
                </p>
              </div>
              <button className="btn btn-secondary" onClick={fetchShopifyStatuses} style={{ fontSize: '12px' }}>
                ↻ Refresh
              </button>
            </div>
          </div>

          {(() => {
            const scentedProducts = groups.flatMap(g => (g.products || []).map(p => ({ ...p, groupName: g.group_name })));
            if (scentedProducts.length === 0) {
              return (
                <div className="card" style={{ textAlign: 'center', padding: '40px', position: 'relative', overflow: 'visible' }}>
                  <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                  <p style={{ color: 'rgba(232,234,242,0.45)' }}>No scented products yet</p>
                </div>
              );
            }

            const counts = { active: 0, draft: 0, archived: 0, notPublished: 0 };
            scentedProducts.forEach(p => {
              const skus = p.shopifySkus && typeof p.shopifySkus === 'object' ? Object.values(p.shopifySkus) : [];
              const status = skus.map(sku => shopifyStatuses[sku]?.status).find(Boolean);
              if (!status)                  counts.notPublished++;
              else if (status === 'active')   counts.active++;
              else if (status === 'draft')    counts.draft++;
              else if (status === 'archived') counts.archived++;
            });

            return (
              <>
                {/* Summary cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                  {[
                    { label: 'Active',        count: counts.active,        color: '#10b981' },
                    { label: 'Draft',         count: counts.draft,         color: '#f59e0b' },
                    { label: 'Archived',      count: counts.archived,      color: '#6b7280' },
                    { label: 'Not Published', count: counts.notPublished,  color: '#94a3b8' },
                  ].map(s => (
                    <div key={s.label} className="card" style={{ textAlign: 'center', padding: '14px', position: 'relative', overflow: 'visible' }}>
                      <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                      <div style={{ fontSize: '26px', fontWeight: '800', color: s.color, marginBottom: '4px' }}>{s.count}</div>
                      <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.5)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {s.label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Table */}
                <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
                  <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                  <div className="table-scroll" style={{ overflowX: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Product</th>
                          <th>Line</th>
                          <th>Stock</th>
                          <th>Shopify Title</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scentedProducts.map(p => {
                          const skus = p.shopifySkus && typeof p.shopifySkus === 'object' ? Object.values(p.shopifySkus) : [];
                          const status = skus.map(sku => shopifyStatuses[sku]?.status).find(Boolean);
                          const shopifyInfo = skus.map(sku => shopifyStatuses[sku]).find(Boolean);
                          const stock = parseFloat(p.currentStock ?? 0);
                          const min   = parseFloat(p.minStockLevel ?? 0);
                          const stockBadge = stock <= 0 ? 'badge-danger' : stock <= min ? 'badge-warning' : 'badge-success';
                          return (
                            <tr key={p.id}>
                              <td>
                                <span style={{ fontFamily: 'monospace', fontSize: '12px', fontWeight: '700', color: '#93c5fd' }}>
                                  {p.productCode}
                                </span>
                              </td>
                              <td style={{ fontWeight: '600', fontSize: '13px' }}>{p.name}</td>
                              <td>
                                <span style={{
                                  fontSize: '11px', fontWeight: '700', color: '#a5b4fc',
                                  background: 'rgba(165,180,252,0.08)', padding: '2px 8px', borderRadius: '4px',
                                }}>
                                  {p.groupName}
                                </span>
                              </td>
                              <td>
                                <span className={`badge ${stockBadge}`} style={{ fontSize: '11px', padding: '2px 8px', fontWeight: '700' }}>
                                  {stock} {p.unit}
                                </span>
                              </td>
                              <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.6)' }}>
                                {shopifyInfo?.title || <span style={{ color: 'rgba(232,234,242,0.3)' }}>—</span>}
                              </td>
                              <td>{getShopifyBadge(p)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ════════════════════════ TAB: CONTAINERS ════════════════════════ */}
      {activeTab === 'containers' && (
        <div>
          {/* Container cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            {containers.length === 0 ? (
              <div className="card" style={{ gridColumn: '1/-1', textAlign: 'center', padding: '60px', position: 'relative', overflow: 'visible' }}>
                <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                <p style={{ color: 'rgba(232,234,242,0.4)', marginBottom: '16px' }}>No container templates yet</p>
                {isRoot && (
                  <button className="btn btn-primary" onClick={() => { resetContainerForm(); setShowAddContainerModal(true); }}>
                    + Add Container
                  </button>
                )}
              </div>
            ) : containers.map(c => {
              const isSelected    = selectedContainerId === c.id;
              const isHighlighted = highlightedContainerId === c.id;
              return (
                <div
                  key={c.id}
                  data-container-id={c.id}
                  className={`card ${isHighlighted ? 'scented-new-card' : ''}`}
                  style={{
                    position: 'relative', overflow: 'visible',
                    border:     isSelected ? '1px solid rgba(99,102,241,0.5)' : undefined,
                    boxShadow:  isSelected ? '0 0 20px rgba(99,102,241,0.12)' : undefined,
                    transition: 'transform 0.4s ease',
                    transform:  isHighlighted ? 'scale(1.02)' : 'scale(1)',
                  }}
                >
                  <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
                  {isHighlighted && (
                    <div style={{
                      position: 'absolute', top: '-10px', right: '14px', zIndex: 5,
                      background: 'linear-gradient(135deg, #6366f1, #ec4899)',
                      color: '#fff', fontSize: '10px', fontWeight: '800',
                      padding: '3px 10px', borderRadius: '20px',
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      boxShadow: '0 4px 14px rgba(99,102,241,0.5)',
                      animation: 'scentedNewBadge 1.4s ease-in-out infinite',
                    }}>
                      ✨ Just Added
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div>
                      <div style={{ fontWeight: '700', fontSize: '15px', marginBottom: '6px' }}>{c.name}</div>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{
                          fontFamily: 'monospace', fontSize: '11px', color: '#a5b4fc',
                          background: 'rgba(165,180,252,0.08)', padding: '2px 7px', borderRadius: '4px', fontWeight: '700',
                        }}>
                          {c.sku_prefix}
                        </span>
                        {c.volume_ml && (
                          <span style={{ fontSize: '11px', color: 'rgba(232,234,242,0.5)', background: 'rgba(128,128,128,0.08)', padding: '2px 7px', borderRadius: '4px' }}>
                            {fmt(c.volume_ml)} mL
                          </span>
                        )}
                        {c.price != null && (
                          <span style={{
                            fontSize: '11px', color: '#86efac', fontWeight: '700',
                            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                            padding: '2px 7px', borderRadius: '4px',
                          }}>
                            ${parseFloat(c.price).toFixed(2)}
                          </span>
                        )}
                        <span style={{ fontSize: '11px', color: 'rgba(232,234,242,0.35)' }}>
                          {(c.bom || []).length} component{(c.bom || []).length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    {isRoot && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button className="btn btn-secondary" onClick={() => openEditContainer(c)} style={{ fontSize: '11px', padding: '3px 10px' }}>Edit</button>
                        <button className="btn btn-danger"    onClick={() => handleDeleteContainer(c.id, c.name)} style={{ fontSize: '11px', padding: '3px 10px' }}>Del</button>
                      </div>
                    )}
                  </div>
                  {c.notes && (
                    <p style={{ fontSize: '12px', color: 'rgba(232,234,242,0.4)', margin: '0 0 10px' }}>{c.notes}</p>
                  )}
                  <button
                    onClick={() => {
                      setSelectedContainerId(prev => prev === c.id ? null : c.id);
                      if (isHighlighted) setHighlightedContainerId(null);
                    }}
                    className={`btn ${isSelected ? 'btn-primary' : 'btn-secondary'} ${isHighlighted ? 'scented-bom-pulse' : ''}`}
                    style={{ width: '100%', fontSize: '12px', position: 'relative' }}
                  >
                    {isSelected ? 'Hide BOM ▲' : 'Manage BOM ▼'}
                    {isHighlighted && !isSelected && (
                      <span style={{
                        marginLeft: '6px', fontSize: '10px', fontWeight: '700',
                        background: 'rgba(255,255,255,0.18)', padding: '1px 6px',
                        borderRadius: '4px', letterSpacing: '0.04em',
                      }}>
                        configure now
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {/* BOM panel */}
          {selectedContainerId && selectedContainer && (
            <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
              <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#a5b4fc' }}>
                    BOM Template — {selectedContainer.name}
                  </h3>
                  <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                    Components debited when this product is fulfilled on Shopify
                  </p>
                </div>
                {isRoot && (
                  <button className="btn btn-primary" onClick={openAddBomRow} style={{ fontSize: '12px' }}>
                    + Add Component
                  </button>
                )}
              </div>

              {selectedBomRows.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(232,234,242,0.3)' }}>
                  <p style={{ marginBottom: '12px' }}>No components yet</p>
                  {isRoot && (
                    <button className="btn btn-primary" onClick={openAddBomRow}>+ Add First Component</button>
                  )}
                </div>
              ) : (
                <div className="table-scroll" style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: '50px' }}>#</th>
                        <th>Component</th>
                        <th style={{ width: '110px' }}>Quantity</th>
                        <th style={{ width: '70px' }}>Unit</th>
                        <th style={{ width: '130px' }}>Type</th>
                        {isRoot && <th style={{ width: '140px' }}>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedBomRows.map((row, idx) => (
                        <tr key={row.id || idx}>
                          <td style={{ fontWeight: '600', color: 'rgba(232,234,242,0.45)' }}>{row.seq ?? idx + 1}</td>
                          <td>
                            {row.is_fragrance ? (
                              <span style={{ color: '#f9a8d4', fontStyle: 'italic', fontSize: '13px' }}>
                                Fragrance Oil — auto-filled on line creation
                              </span>
                            ) : (
                              <div>
                                <span style={{ fontFamily: 'monospace', fontSize: '13px', color: '#93c5fd' }}>
                                  {row.component_code}
                                </span>
                                {row.component_name && (
                                  <span style={{ fontSize: '12px', color: 'rgba(232,234,242,0.5)', marginLeft: '8px' }}>
                                    {row.component_name}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ fontWeight: '600' }}>{fmt(row.quantity)}</td>
                          <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.6)' }}>{row.unit}</td>
                          <td>
                            {row.is_fragrance ? (
                              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', fontWeight: '700', background: 'rgba(249,168,212,0.1)', border: '1px solid rgba(249,168,212,0.3)', color: '#f9a8d4' }}>
                                FRAGRANCE
                              </span>
                            ) : (
                              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', fontWeight: '600', background: 'rgba(128,128,128,0.1)', border: '1px solid var(--border)', color: 'rgba(232,234,242,0.5)' }}>
                                COMPONENT
                              </span>
                            )}
                          </td>
                          {isRoot && (
                            <td>
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button className="btn btn-secondary" onClick={() => openEditBomRow(row)} style={{ fontSize: '11px', padding: '3px 10px' }}>Edit</button>
                                <button className="btn btn-danger"    onClick={() => handleDeleteBomRow(row.id)} style={{ fontSize: '11px', padding: '3px 10px' }}>Remove</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════ MODALS ════════════════════════════ */}

      {/* Add / Edit Container */}
      {(showAddContainerModal || showEditContainerModal) && (
        <div className="modal-overlay" onClick={() => { setShowAddContainerModal(false); setShowEditContainerModal(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{showEditContainerModal ? 'Edit Container' : 'Add Container Template'}</h2>
              <button className="modal-close" onClick={() => { setShowAddContainerModal(false); setShowEditContainerModal(false); }}>×</button>
            </div>
            <form onSubmit={showEditContainerModal ? handleEditContainer : handleAddContainer}>
              <div className="form-group">
                <label>Container Name</label>
                <input className="input" type="text" value={containerForm.name}
                  onChange={e => setContainerForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Reed Diffuser 200ml" required />
              </div>
              <div className="form-group">
                <label>
                  SKU Prefix
                  {showEditContainerModal && (
                    <span style={{ color: 'rgba(232,234,242,0.35)', fontWeight: '400', marginLeft: '6px' }}>— cannot be changed</span>
                  )}
                </label>
                <input className="input" type="text" value={containerForm.skuPrefix}
                  onChange={e => setContainerForm(p => ({ ...p, skuPrefix: e.target.value.toUpperCase() }))}
                  placeholder="e.g. SA_RD"
                  disabled={showEditContainerModal}
                  style={showEditContainerModal ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                  required={!showEditContainerModal} />
              </div>
              <div className="form-group">
                <label>
                  Volume (mL)
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional</span>
                </label>
                <input className="input" type="number" value={containerForm.volumeMl}
                  onChange={e => setContainerForm(p => ({ ...p, volumeMl: e.target.value }))}
                  placeholder="e.g. 200" min="0" step="0.001" />
              </div>
              <div className="form-group">
                <label>
                  Retail Price (AUD)
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— used when publishing to Shopify</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{
                    position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
                    color: 'rgba(232,234,242,0.45)', fontSize: '14px', fontWeight: '600', pointerEvents: 'none',
                  }}>$</span>
                  <input className="input" type="number" value={containerForm.price}
                    onChange={e => setContainerForm(p => ({ ...p, price: e.target.value }))}
                    placeholder="e.g. 39.95" min="0" step="0.01"
                    style={{ paddingLeft: '26px' }} />
                </div>
              </div>
              <div className="form-group">
                <label>
                  Notes
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional</span>
                </label>
                <input className="input" type="text" value={containerForm.notes}
                  onChange={e => setContainerForm(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Internal notes" />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowAddContainerModal(false); setShowEditContainerModal(false); }}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {showEditContainerModal ? 'Save Changes' : 'Add Container'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add / Edit BOM Row */}
      {showBomModal && (
        <div className="modal-overlay" onClick={closeBomModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingBomItem ? 'Edit BOM Component' : `Add Component — ${selectedContainer?.name}`}</h2>
              <button className="modal-close" onClick={closeBomModal}>×</button>
            </div>
            <form onSubmit={handleSaveBomRow}>
              {!editingBomItem && (
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: '500' }}>
                    <input type="checkbox" checked={bomForm.isFragrance}
                      onChange={e => setBomForm(p => ({ ...p, isFragrance: e.target.checked, componentCode: '', componentName: '' }))} />
                    This is the fragrance oil placeholder
                  </label>
                  <p style={{ fontSize: '11px', color: 'rgba(232,234,242,0.4)', margin: '4px 0 0 24px' }}>
                    Auto-filled with the selected fragrance oil when a new line is created.
                  </p>
                </div>
              )}
              {editingBomItem?.is_fragrance && (
                <p style={{ fontSize: '13px', color: '#f9a8d4', fontStyle: 'italic', marginBottom: '16px' }}>
                  Fragrance placeholder — only quantity and unit can be edited.
                </p>
              )}
              {!bomForm.isFragrance && !editingBomItem?.is_fragrance && (
                <>
                  <div className="form-group">
                    <label>Select Raw Material</label>
                    <select className="input" value={bomForm.componentCode} onChange={handleRmSelect}>
                      <option value="">— Select from Raw Materials —</option>
                      {rawMaterials.map(rm => (
                        <option key={rm.productCode} value={rm.productCode}>{rm.productCode} — {rm.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Component Code</label>
                    <input className="input" type="text" value={bomForm.componentCode}
                      onChange={e => setBomForm(p => ({ ...p, componentCode: e.target.value }))}
                      placeholder="e.g. RM_BOTTLE_001"
                      disabled={!!editingBomItem}
                      style={editingBomItem ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                      required />
                  </div>
                  <div className="form-group">
                    <label>
                      Component Name
                      <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional</span>
                    </label>
                    <input className="input" type="text" value={bomForm.componentName}
                      onChange={e => setBomForm(p => ({ ...p, componentName: e.target.value }))}
                      placeholder="e.g. Glass Bottle 100ml" />
                  </div>
                </>
              )}
              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Quantity</label>
                  <input className="input" type="number" value={bomForm.quantity}
                    onChange={e => setBomForm(p => ({ ...p, quantity: e.target.value }))}
                    placeholder="e.g. 50" min="0" step="0.001" required />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Unit</label>
                  <select className="input" value={bomForm.unit} onChange={e => setBomForm(p => ({ ...p, unit: e.target.value }))}>
                    <option value="mL">mL</option>
                    <option value="units">units</option>
                    <option value="g">g</option>
                  </select>
                </div>
              </div>

              {/* % helper — only relevant when liquid (mL) and the container has a known volume */}
              {bomForm.unit === 'mL' && selectedContainer?.volume_ml > 0 && (() => {
                const containerVol = parseFloat(selectedContainer.volume_ml);
                const currentQty   = parseFloat(bomForm.quantity);
                const currentPct   = !isNaN(currentQty) && containerVol > 0
                  ? Math.round((currentQty / containerVol) * 10000) / 100
                  : '';
                return (
                  <div className="form-group" style={{
                    background: 'rgba(99,102,241,0.06)',
                    border: '1px solid rgba(99,102,241,0.18)',
                    borderRadius: '8px', padding: '12px 14px', marginTop: '-6px',
                  }}>
                    <label style={{ color: '#a5b4fc', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>💡</span>
                      <span>Quick fill from % of container volume</span>
                    </label>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' }}>
                      <input
                        type="number"
                        className="input"
                        style={{ flex: '0 0 90px' }}
                        placeholder="e.g. 25"
                        min="0" max="100" step="0.1"
                        value={currentPct}
                        onChange={e => {
                          const pct = parseFloat(e.target.value);
                          if (isNaN(pct)) {
                            setBomForm(p => ({ ...p, quantity: '' }));
                          } else {
                            const newQty = (containerVol * pct) / 100;
                            const rounded = Math.round(newQty * 1000) / 1000;
                            setBomForm(p => ({ ...p, quantity: String(rounded) }));
                          }
                        }}
                      />
                      <span style={{ fontSize: '13px', color: 'rgba(232,234,242,0.55)' }}>
                        % of {fmt(containerVol)} mL container
                      </span>
                    </div>
                    {currentQty > 0 && currentPct !== '' && (
                      <div style={{ marginTop: '8px', fontSize: '12px', color: 'rgba(232,234,242,0.55)' }}>
                        = <strong style={{ color: '#a5b4fc' }}>{fmt(currentQty)} mL</strong>
                        <span style={{ margin: '0 8px', color: 'rgba(232,234,242,0.25)' }}>·</span>
                        <strong style={{ color: '#a5b4fc' }}>{currentPct}%</strong> of container
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeBomModal}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editingBomItem ? 'Save Changes' : 'Add Component'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Scented Line */}
      {showCreateGroupModal && (
        <div className="modal-overlay" onClick={() => setShowCreateGroupModal(false)}>
          <div className="modal" style={{ maxWidth: '520px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Scented Line</h2>
              <button className="modal-close" onClick={() => setShowCreateGroupModal(false)}>×</button>
            </div>
            <form onSubmit={handleCreateGroup}>
              <div className="form-group">
                <label>Line Name (Fragrance)</label>
                <input className="input" type="text" value={groupForm.groupName}
                  onChange={e => setGroupForm(p => ({ ...p, groupName: e.target.value }))}
                  placeholder="e.g. Santal" required />
              </div>
              <div className="form-group" style={{ position: 'relative' }}>
                <label>Fragrance Oil</label>
                {(() => {
                  const selected = oilProducts.find(p => p.id === groupForm.fragranceProductId);
                  const q = fragranceSearch.trim().toLowerCase();
                  const filtered = q
                    ? oilProducts.filter(p =>
                        (p.name || '').toLowerCase().includes(q) ||
                        (p.productCode || '').toLowerCase().includes(q) ||
                        (p.tag || '').toLowerCase().includes(q))
                    : oilProducts;
                  return (
                    <>
                      <input
                        type="text"
                        className="input"
                        placeholder={selected ? '' : 'Type to search fragrance oils...'}
                        value={fragranceDropdownOpen
                          ? fragranceSearch
                          : (selected ? `${selected.productCode} — ${selected.name}` : fragranceSearch)}
                        onChange={e => {
                          setFragranceSearch(e.target.value);
                          setFragranceDropdownOpen(true);
                          if (groupForm.fragranceProductId) {
                            setGroupForm(p => ({ ...p, fragranceProductId: '' }));
                          }
                        }}
                        onFocus={() => setFragranceDropdownOpen(true)}
                        onBlur={() => setTimeout(() => setFragranceDropdownOpen(false), 150)}
                        autoComplete="off"
                      />
                      {selected && !fragranceDropdownOpen && (
                        <button type="button" onClick={() => {
                          setGroupForm(p => ({ ...p, fragranceProductId: '' }));
                          setFragranceSearch('');
                        }} style={{
                          position: 'absolute', right: '10px', top: '34px', background: 'none',
                          border: 'none', color: 'rgba(232,234,242,0.4)', cursor: 'pointer',
                          fontSize: '16px', padding: '4px 8px',
                        }}>×</button>
                      )}
                      {fragranceDropdownOpen && (
                        <div style={{
                          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                          maxHeight: '240px', overflowY: 'auto',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: '8px', zIndex: 10,
                          boxShadow: '0 12px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(99,102,241,0.15)',
                          backdropFilter: 'none',
                        }}>
                          {filtered.length === 0 ? (
                            <div style={{ padding: '12px', fontSize: '13px', color: 'rgba(232,234,242,0.4)', textAlign: 'center' }}>
                              No fragrance oils match "{fragranceSearch}"
                            </div>
                          ) : filtered.map(p => (
                            <div
                              key={p.id}
                              onMouseDown={() => {
                                setGroupForm(g => ({ ...g, fragranceProductId: p.id }));
                                setFragranceSearch('');
                                setFragranceDropdownOpen(false);
                              }}
                              style={{
                                padding: '10px 12px', cursor: 'pointer', fontSize: '13px',
                                borderBottom: '1px solid rgba(255,255,255,0.04)',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.1)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                            >
                              <div style={{ fontWeight: '600' }}>{p.name}</div>
                              <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.45)', fontFamily: 'monospace', marginTop: '2px' }}>
                                {p.productCode}
                                {p.currentStock !== undefined && (
                                  <span style={{ marginLeft: '10px' }}>
                                    Stock: <strong style={{ color: p.currentStock > 0 ? '#10b981' : '#f87171' }}>
                                      {p.currentStock} {p.unit}
                                    </strong>
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              <div className="form-group">
                <label>
                  Fragrance Description
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional, published to Shopify</span>
                </label>
                <textarea
                  className="input"
                  rows="3"
                  value={groupForm.fragranceDescription}
                  onChange={e => setGroupForm(p => ({ ...p, fragranceDescription: e.target.value }))}
                  placeholder="A warm, sensual blend of sandalwood and amber..."
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              <div className="form-group">
                <label>
                  Fragrance Type
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional</span>
                </label>
                <input
                  className="input"
                  type="text"
                  value={groupForm.fragranceType}
                  onChange={e => setGroupForm(p => ({ ...p, fragranceType: e.target.value }))}
                  placeholder="e.g. Woody Oriental, Citrus Fresh, Floral..."
                />
              </div>

              <div className="form-group">
                <label>
                  Notes
                  <span style={{ color: 'rgba(232,234,242,0.4)', fontWeight: '400', marginLeft: '6px' }}>— optional, e.g. top/middle/base notes</span>
                </label>
                <textarea
                  className="input"
                  rows="2"
                  value={groupForm.fragranceNotes}
                  onChange={e => setGroupForm(p => ({ ...p, fragranceNotes: e.target.value }))}
                  placeholder="Top: Bergamot · Middle: Rose · Base: Sandalwood"
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              <div className="form-group">
                <label>Containers to create</label>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: '8px',
                  padding: '12px', background: 'rgba(128,128,128,0.06)',
                  borderRadius: '8px', border: '1px solid var(--border)',
                }}>
                  {containers.length === 0 ? (
                    <p style={{ color: 'rgba(232,234,242,0.4)', fontSize: '13px', margin: 0 }}>
                      No containers defined. Add them in the Container Management tab first.
                    </p>
                  ) : containers.map(c => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                      <input type="checkbox"
                        checked={groupForm.containerIds.includes(c.id)}
                        onChange={e => setGroupForm(p => ({
                          ...p,
                          containerIds: e.target.checked
                            ? [...p.containerIds, c.id]
                            : p.containerIds.filter(id => id !== c.id)
                        }))} />
                      <span style={{ fontWeight: '500' }}>{c.name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#a5b4fc' }}>{c.sku_prefix}</span>
                      {c.volume_ml && (
                        <span style={{ fontSize: '11px', color: 'rgba(232,234,242,0.4)' }}>{fmt(c.volume_ml)}mL</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>

              {previewSkus().length > 0 && (
                <div style={{
                  background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
                  borderRadius: '8px', padding: '12px', marginBottom: '16px',
                }}>
                  <div style={{ fontSize: '11px', fontWeight: '700', color: '#a5b4fc', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Products that will be created:
                  </div>
                  {previewSkus().map((s, i) => (
                    <div key={i} style={{ fontSize: '13px', color: 'rgba(232,234,242,0.7)', marginBottom: '4px' }}>
                      <span style={{ fontFamily: 'monospace', color: '#93c5fd' }}>{s.sku}</span>
                      {' — '}{groupForm.groupName || '...'} - {s.container}
                    </div>
                  ))}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateGroupModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingGroup}>
                  {savingGroup ? 'Creating...' : 'Create Line'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Animations for newly-added container highlight */}
      <style>{`
        @keyframes scentedCardGlow {
          0%, 100% {
            box-shadow:
              0 0 0 1px rgba(99,102,241,0.6),
              0 0 32px rgba(99,102,241,0.45),
              0 0 60px rgba(236,72,153,0.25);
          }
          50% {
            box-shadow:
              0 0 0 2px rgba(236,72,153,0.7),
              0 0 48px rgba(236,72,153,0.55),
              0 0 90px rgba(99,102,241,0.35);
          }
        }
        @keyframes scentedNewBadge {
          0%, 100% { transform: translateY(0) scale(1); }
          50%      { transform: translateY(-2px) scale(1.05); }
        }
        @keyframes scentedBomPulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(236,72,153,0.55);
          }
          50% {
            transform: scale(1.03);
            box-shadow: 0 0 0 8px rgba(236,72,153,0);
          }
        }
        .scented-new-card {
          animation: scentedCardGlow 1.8s ease-in-out infinite;
          border: 1px solid rgba(99,102,241,0.5) !important;
        }
        .scented-bom-pulse {
          animation: scentedBomPulse 1.4s ease-in-out infinite;
          background: linear-gradient(135deg, #6366f1, #ec4899) !important;
          border-color: transparent !important;
          color: #fff !important;
          font-weight: 700 !important;
        }
      `}</style>

      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {/* Delete group — 3-way modal */}
      {deleteGroupTarget && (
        <div className="modal-overlay" onClick={() => setDeleteGroupTarget(null)}>
          <div className="modal" style={{ maxWidth: '480px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete "{deleteGroupTarget.name}"</h2>
              <button className="modal-close" onClick={() => setDeleteGroupTarget(null)}>×</button>
            </div>
            <p style={{ color: 'var(--text-primary)', fontSize: '14px', lineHeight: '1.6', margin: '0 0 20px 0' }}>
              How do you want to delete this scented line?
            </p>

            <div style={{
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: '8px', padding: '12px', marginBottom: '10px',
            }}>
              <div style={{ fontWeight: '700', fontSize: '13px', color: '#a5b4fc', marginBottom: '4px' }}>
                Keep products
              </div>
              <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.6)' }}>
                Group is removed, products stay in Stock/Products with their stock and transaction history.
              </div>
            </div>

            <div style={{
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '8px', padding: '12px', marginBottom: '20px',
            }}>
              <div style={{ fontWeight: '700', fontSize: '13px', color: '#f87171', marginBottom: '4px' }}>
                Delete everything
              </div>
              <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.6)' }}>
                Removes group, all products in the line, their BOM components, and stock transactions. Cannot be undone.
              </div>
            </div>

            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <button className="btn btn-secondary" onClick={() => setDeleteGroupTarget(null)} style={{ fontSize: '13px' }}>
                Cancel
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={() => doDeleteGroup(false)} style={{ fontSize: '13px' }}>
                  Keep Products
                </button>
                <button className="btn btn-danger" onClick={() => doDeleteGroup(true)} style={{ fontSize: '13px' }}>
                  Delete Everything
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
