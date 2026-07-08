import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';

export default function BOMViewer({ user }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [bom, setBom] = useState({});
  const [selectedVariant, setSelectedVariant] = useState('SA_CA');
  const [selectedSubCategory, setSelectedSubCategory] = useState('ALL');
  const [products, setProducts] = useState([]);
  const [rawMaterials, setRawMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingComponent, setEditingComponent] = useState(null);
  const [formData, setFormData] = useState({
    componentCode: '',
    componentName: '',
    quantity: 1
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [bomRes, productsRes] = await Promise.all([
        fetch('/api/bom'),
        fetch('/api/products')
      ]);

      if (!bomRes.ok || !productsRes.ok) throw new Error('Failed to load BOM data');
      const bomData = await bomRes.json();
      const productsData = await productsRes.json();

      setBom(bomData && typeof bomData === 'object' && !Array.isArray(bomData) ? bomData : {});
      const safeProducts = Array.isArray(productsData) ? productsData : [];
      setProducts(safeProducts);
      setRawMaterials(safeProducts.filter(p => p.category === 'RAW_MATERIALS'));
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getProductByCode = (code) => {
    return products.find(p => p.productCode === code);
  };

  const VARIANT_CONFIG = {
    'SA_CA':           { name: 'Oil Cartridge (400ml)',  volume: 400,  color: '#667eea', subCategory: 'Oil Products' },
    'SA_HF':           { name: '500ml Refill Bottle',    volume: 500,  color: '#fa709a', subCategory: 'Oil Products' },
    'SA_CDIFF':        { name: '700ml Oil Refill',       volume: 700,  color: '#4facfe', subCategory: 'Oil Products' },
    'SA_1L':           { name: '1L Refill Bottle',       volume: 1000, color: '#f093fb', subCategory: 'Oil Products' },
    'SA_PRO':          { name: '1L PRO Bottle',          volume: 1000, color: '#43e97b', subCategory: 'Oil Products' },
    'REFURB_SCENTPRO': { name: 'Refurb - Scentpro',     volume: 0,    color: '#f59e0b', subCategory: 'Refurb - Scentpro' },
    'REFURB_SCENTLITE':{ name: 'Refurb - ScentLite',    volume: 0,    color: '#06b6d4', subCategory: 'Refurb - ScentLite' },
  };

  const ALL_KNOWN_VARIANTS = Object.keys(VARIANT_CONFIG);

  const getVariantName   = (v) => VARIANT_CONFIG[v]?.name   || v;
  const getVariantVolume = (v) => VARIANT_CONFIG[v]?.volume  || 0;
  const getVariantColor  = (v) => VARIANT_CONFIG[v]?.color   || '#667eea';
  const getVariantSubCat = (v) => VARIANT_CONFIG[v]?.subCategory || 'Other';

  const SUB_CATEGORIES = ['ALL', 'Oil Products', 'Refurb - Scentpro', 'Refurb - ScentLite'];
  const SUB_CATEGORY_COLORS = {
    'ALL':              '#667eea',
    'Oil Products':     '#10b981',
    'Refurb - Scentpro':'#f59e0b',
    'Refurb - ScentLite':'#06b6d4',
  };

  // Hide variants that belong to SA_SCENTED_PRODUCTS — those are managed in
  // the Scented Products page via container templates, not here.
  const scentedProductCodes = new Set(
    products.filter(p => p.category === 'SA_SCENTED_PRODUCTS').map(p => p.productCode)
  );

  // All known variants merged with server BOM (so empty refurb variants still appear)
  const allVariants = Array.from(new Set([...ALL_KNOWN_VARIANTS, ...Object.keys(bom)]))
    .filter(v => !scentedProductCodes.has(v));
  const filteredVariants = allVariants.filter(v =>
    selectedSubCategory === 'ALL' || getVariantSubCat(v) === selectedSubCategory
  );

  // If current selectedVariant got filtered out (e.g. user opened a scented variant before)
  // fall back to the first available variant.
  useEffect(() => {
    if (filteredVariants.length > 0 && !filteredVariants.includes(selectedVariant)) {
      setSelectedVariant(filteredVariants[0]);
    }
  }, [products, bom]);

  const handleAddComponent = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch('/api/bom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: selectedVariant,
          componentCode: formData.componentCode,
          componentName: formData.componentName,
          quantity: formData.quantity
        })
      });

      if (res.ok) {
        const data = await res.json();
        setBom(prev => ({ ...prev, [selectedVariant]: data.bom }));
        setShowAddModal(false);
        resetForm();
        showToast('Component added successfully!', 'success');
      } else {
        const error = await res.json();
        showToast(error.error || 'Error adding component', 'error');
      }
    } catch (error) {
      showToast('Error adding component: ' + error.message, 'error');
    }
  };

  const handleEditComponent = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch(`/api/bom/${selectedVariant}/component/${editingComponent.componentCode}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          componentName: formData.componentName,
          quantity: formData.quantity
        })
      });

      if (res.ok) {
        const data = await res.json();
        setBom(prev => ({ ...prev, [selectedVariant]: data.bom }));
        setShowEditModal(false);
        setEditingComponent(null);
        resetForm();
        showToast('Component updated successfully!', 'success');
      } else {
        const error = await res.json();
        showToast(error.error || 'Error updating component', 'error');
      }
    } catch (error) {
      showToast('Error updating component: ' + error.message, 'error');
    }
  };

  const handleDeleteComponent = async (componentCode) => {
    setConfirmState({ message: 'Are you sure you want to remove this component from the BOM?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/bom/${selectedVariant}/component/${componentCode}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          const data = await res.json();
          setBom(prev => ({ ...prev, [selectedVariant]: data.bom }));
          showToast('Component removed successfully!', 'success');
        } else {
          const error = await res.json();
          showToast(error.error || 'Error removing component', 'error');
        }
      } catch (error) {
        showToast('Error removing component: ' + error.message, 'error');
      }
    }});
  };

  const openEditModal = (component) => {
    setEditingComponent(component);
    setFormData({
      componentCode: component.componentCode,
      componentName: component.componentName,
      quantity: component.quantity
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      componentCode: '',
      componentName: '',
      quantity: 1
    });
  };

  const handleRawMaterialSelect = (e) => {
    const code = e.target.value;
    const rm = rawMaterials.find(r => r.productCode === code);
    if (rm) {
      setFormData({
        componentCode: rm.productCode,
        componentName: rm.name,
        quantity: 1
      });
    }
  };

  const currentBOM = bom[selectedVariant] || [];
  const isAdmin = ['admin', 'root'].includes(user?.role);
  // Ensure selectedVariant stays within filtered set when subcategory changes
  // (handled in filter button onClick — selectedVariant auto-updates)

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading BOM data...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">BILL OF MATERIALS (BOM)</h2>
          <p>Manage components required for each product variant</p>
        </div>
        {isAdmin && (
          <button
            className="btn btn-primary"
            onClick={() => {
              resetForm();
              setShowAddModal(true);
            }}
          >
            + Add Component
          </button>
        )}
      </div>

      {/* SubCategory Filter */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {SUB_CATEGORIES.map(cat => {
          const active = selectedSubCategory === cat;
          const col = SUB_CATEGORY_COLORS[cat];
          return (
            <button
              key={cat}
              onClick={() => {
                setSelectedSubCategory(cat);
                // auto-select first variant of the chosen category
                const first = allVariants.find(v => cat === 'ALL' || getVariantSubCat(v) === cat);
                if (first) setSelectedVariant(first);
              }}
              style={{
                fontSize: '12px', padding: '5px 14px', borderRadius: '20px', fontWeight: '700',
                cursor: 'pointer', fontFamily: 'Inter, sans-serif', transition: 'all 0.2s',
                border: `1px solid ${active ? col : 'rgba(255,255,255,0.12)'}`,
                background: active ? `${col}22` : 'transparent',
                color: active ? col : 'rgba(232,234,242,0.5)',
                boxShadow: active ? `0 0 10px ${col}44` : 'none',
              }}
            >
              {cat === 'ALL' ? 'All Variants' : cat}
            </button>
          );
        })}
      </div>

      {/* Variant Selector */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {filteredVariants.map(variant => (
            <button
              key={variant}
              className={`btn ${selectedVariant === variant ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedVariant(variant)}
              style={selectedVariant === variant ? {
                background: getVariantColor(variant),
                borderColor: getVariantColor(variant),
                boxShadow: `0 0 14px ${getVariantColor(variant)}80, 0 2px 8px ${getVariantColor(variant)}40`,
                color: '#fff',
              } : {}}
            >
              {getVariantName(variant)}
            </button>
          ))}
        </div>
      </div>

      {/* Variant Info */}
      <div className="card" style={{ marginBottom: '24px', borderLeft: `4px solid ${getVariantColor(selectedVariant)}`, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h3 style={{ color: getVariantColor(selectedVariant), marginBottom: '8px', fontSize: '20px' }}>
              {getVariantName(selectedVariant)}
            </h3>
            <p style={{ color: 'rgba(232,234,242,0.45)', margin: 0 }}>
              Components required to produce one unit of {getVariantName(selectedVariant)}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '24px' }}>
            {getVariantVolume(selectedVariant) > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: '700', color: getVariantColor(selectedVariant) }}>
                  {getVariantVolume(selectedVariant)} mL
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>Oil Volume</div>
              </div>
            )}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '700', color: '#10b981' }}>
                {currentBOM.length}
              </div>
              <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>Components</div>
            </div>
          </div>
        </div>
      </div>

      {/* BOM Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        {currentBOM.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.3)' }}>
            <p style={{ fontSize: '18px', marginBottom: '16px' }}>No components defined for this variant</p>
            {isAdmin && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  resetForm();
                  setShowAddModal(true);
                }}
              >
                + Add First Component
              </button>
            )}
          </div>
        ) : (
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '60px' }}>#</th>
                  <th>Component Code</th>
                  <th>Component Name</th>
                  <th style={{ width: '100px' }}>Quantity</th>
                  <th>Current Stock</th>
                  <th>Status</th>
                  {isAdmin && <th style={{ width: '150px' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {currentBOM.map((item, index) => {
                  const product = getProductByCode(item.componentCode);
                  const currentStock = product ? parseFloat(product.currentStock) : 0;
                  const minStock = product ? parseFloat(product.minStockLevel) : 0;
                  const isOut = currentStock <= 0;
                  const isLow = !isOut && currentStock <= minStock;
                  const isOk = !isOut && !isLow;

                  return (
                    <tr key={item.componentCode || index}>
                      <td style={{ fontWeight: '600', color: 'rgba(232,234,242,0.45)' }}>{item.seq || index + 1}</td>
                      <td>
                        <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: '600', color: '#93c5fd' }}>
                          {item.componentCode}
                        </span>
                      </td>
                      <td style={{ fontWeight: '600' }}>{item.componentName}</td>
                      <td>
                        <span style={{
                          background: 'rgba(255,255,255,0.03)',
                          padding: '4px 12px',
                          borderRadius: '4px',
                          fontWeight: '600'
                        }}>
                          {item.quantity} unit{item.quantity > 1 ? 's' : ''}
                        </span>
                      </td>
                      <td>
                        {product ? (
                          <span style={{ fontWeight: '600' }}>
                            {currentStock} {product.unit}
                          </span>
                        ) : (
                          <span style={{ color: 'rgba(232,234,242,0.3)' }}>N/A</span>
                        )}
                      </td>
                      <td>
                        {product ? (
                          <span className={`badge ${isOut ? 'badge-danger' : isLow ? 'badge-warning' : 'badge-success'}`}>
                            {isOut ? '⛔ Out of Stock' : isLow ? '⚠️ Low Stock' : '✅ Available'}
                          </span>
                        ) : (
                          <span className="badge badge-warning">Not Found</span>
                        )}
                      </td>
                      {isAdmin && (
                        <td>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              className="btn btn-secondary"
                              onClick={() => openEditModal(item)}
                              style={{ fontSize: '12px', padding: '4px 12px' }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-danger"
                              onClick={() => handleDeleteComponent(item.componentCode)}
                              style={{ fontSize: '12px', padding: '4px 12px' }}
                            >
                              Remove
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
        )}
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '24px' }}>
        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#3b82f6', marginBottom: '8px' }}>
            {currentBOM.length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Total Components</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#ef4444', marginBottom: '8px' }}>
            {currentBOM.filter(item => {
              const product = getProductByCode(item.componentCode);
              return product && (parseFloat(product.currentStock) <= parseFloat(product.minStockLevel));
            }).length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Low Stock Components</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#8b5cf6', marginBottom: '8px' }}>
            {Object.keys(bom).length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Total Variants</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#10b981', marginBottom: '8px' }}>
            {rawMaterials.length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Available Raw Materials</div>
        </div>
      </div>

      {/* Add Component Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Component to {getVariantName(selectedVariant)}</h2>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>

            <form onSubmit={handleAddComponent}>
              <div className="form-group">
                <label>Select Raw Material</label>
                <select
                  className="input"
                  onChange={handleRawMaterialSelect}
                  value={formData.componentCode}
                >
                  <option value="">-- Select a Raw Material --</option>
                  {rawMaterials.map(rm => (
                    <option key={rm.productCode} value={rm.productCode}>
                      {rm.productCode} - {rm.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Component Code</label>
                <input
                  type="text"
                  className="input"
                  value={formData.componentCode}
                  onChange={(e) => setFormData({...formData, componentCode: e.target.value})}
                  placeholder="e.g., SA_RM_00003"
                  required
                />
              </div>

              <div className="form-group">
                <label>Component Name</label>
                <input
                  type="text"
                  className="input"
                  value={formData.componentName}
                  onChange={(e) => setFormData({...formData, componentName: e.target.value})}
                  placeholder="e.g., Empty Oil Cartridge (400ml)"
                  required
                />
              </div>

              <div className="form-group">
                <label>Quantity per Unit</label>
                <input
                  type="number"
                  className="input"
                  value={formData.quantity}
                  onChange={(e) => setFormData({...formData, quantity: parseInt(e.target.value) || 1})}
                  min="1"
                  required
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Component
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

      {/* Edit Component Modal */}
      {showEditModal && editingComponent && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit Component</h2>
              <button className="modal-close" onClick={() => setShowEditModal(false)}>×</button>
            </div>

            <form onSubmit={handleEditComponent}>
              <div className="form-group">
                <label>Component Code</label>
                <input
                  type="text"
                  className="input"
                  value={formData.componentCode}
                  disabled
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                />
              </div>

              <div className="form-group">
                <label>Component Name</label>
                <input
                  type="text"
                  className="input"
                  value={formData.componentName}
                  onChange={(e) => setFormData({...formData, componentName: e.target.value})}
                  required
                />
              </div>

              <div className="form-group">
                <label>Quantity per Unit</label>
                <input
                  type="number"
                  className="input"
                  value={formData.quantity}
                  onChange={(e) => setFormData({...formData, quantity: parseInt(e.target.value) || 1})}
                  min="1"
                  required
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Update Component
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
