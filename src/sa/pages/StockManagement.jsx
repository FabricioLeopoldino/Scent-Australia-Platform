import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import { displayStock, displayUnit } from '../utils/unitConversion';
import BinLocationInput from '../components/BinLocationInput';
import { GlowingEffect } from '../components/GlowingEffect';
import MlHelper from '../components/MlHelper';
import { LiquidMetalButton } from '../components/LiquidMetalButton';

export default function StockManagement({ user }) {
  const showToast = useToast();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [type, setType] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [locationProduct, setLocationProduct] = useState(null);
  const [newLocation, setNewLocation] = useState('');

  const [safetyMap, setSafetyMap] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const productsRes = await fetch('/api/products');
      const productsData = await productsRes.json();
      setProducts(Array.isArray(productsData) ? productsData : []);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
    // Fetch replenishment data separately so it never blocks product loading
    try {
      const replRes = await fetch('/api/dashboard/replenishment');
      if (replRes.ok) {
        const replData = await replRes.json();
        const map = {};
        (replData.products || []).forEach(p => { map[p.id] = p.safetyStatus; });
        setSafetyMap(map);
      }
    } catch (error) {
      console.error('Error fetching replenishment:', error);
    }
  };

  const handleAdjust = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch('/api/stock/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: selectedProduct.id,
          quantity: parseInt(quantity),
          type,
          note: notes,
          userId: user?.id || null
        })
      });

      if (res.ok) {
        setShowModal(false);
        setQuantity('');
        setNotes('');
        showToast(`Stock ${type === 'add' ? 'added' : 'removed'} successfully!`, 'success');
        fetchProducts(); // background refresh — don't await
      } else {
        const error = await res.json();
        showToast(error.error || 'Failed to adjust stock', 'error');
      }
    } catch (error) {
      console.error('Error:', error);
      showToast('Error adjusting stock', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateLocation = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch(`/api/products/${locationProduct.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bin_location: newLocation || null
        })
      });

      if (res.ok) {
        showToast('Location updated successfully!', 'success');
        setShowLocationModal(false);
        setLocationProduct(null);
        setNewLocation('');
        fetchProducts();
      } else {
        const error = await res.json();
        showToast(`Error: ${error.error || 'Failed to update location'}`, 'error');
      }
    } catch (error) {
      console.error('Error:', error);
      showToast('Error updating location: ' + error.message, 'error');
    }
  };

  const getCategoryLabel = (category) => {
    const labels = {
      OILS: 'Oils',
      SA_SCENTED_PRODUCTS: 'Scented Products',
      MACHINES_SPARES: 'Spares',
      RAW_MATERIALS: 'Raw Materials'
    };
    return labels[category] || category;
  };

  const getStockStatus = (product) => {
    if (product.currentStock === 0) return { label: 'Out of Stock', class: 'red' };
    if (product.currentStock < product.minStockLevel) return { label: 'Low Stock', class: 'yellow' };
    return { label: 'Healthy', class: 'green' };
  };

  const filteredProducts = products.filter(product => {
    const matchesSearch = (product.name?.toLowerCase() ?? '').includes(search.toLowerCase()) ||
                         (product.productCode?.toLowerCase() ?? '').includes(search.toLowerCase()) ||
                         (product.tag?.toLowerCase() ?? '').includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'ALL' || product.category === categoryFilter;
    const matchesStatus = statusFilter === 'ALL' || getStockStatus(product).label === statusFilter;
    return matchesSearch && matchesCategory && matchesStatus;
  });

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading stock...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <h2 className="page-title">STOCK MANAGEMENT</h2>
        <LiquidMetalButton label="Tech Stock" width={130} onClick={() => window.location.href = '/tech-stock'} />
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1', minWidth: '200px' }}>
            <input
              type="text"
              className="input"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { value: 'ALL', label: 'All' },
              { value: 'OILS', label: 'Oils' },
              { value: 'SA_SCENTED_PRODUCTS', label: 'Scented' },
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

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { value: 'ALL',           label: 'All Status',    color: null },
              { value: 'Healthy',       label: '✅ Healthy',    color: '#22c55e' },
              { value: 'Low Stock',     label: '⚠️ Low Stock',  color: '#fbbf24' },
              { value: 'Out of Stock',  label: '🔴 Out of Stock', color: '#ef4444' },
            ].map(s => (
              <button
                key={s.value}
                className="btn"
                onClick={() => setStatusFilter(s.value)}
                style={{
                  fontSize: '13px',
                  padding: '8px 16px',
                  background: statusFilter === s.value
                    ? (s.color ? `${s.color}22` : 'rgba(59,130,246,0.18)')
                    : 'rgba(255,255,255,0.04)',
                  color: statusFilter === s.value
                    ? (s.color || '#3b82f6')
                    : 'rgba(232,234,242,0.45)',
                  border: `1px solid ${statusFilter === s.value ? (s.color || '#3b82f6') + '66' : 'rgba(255,255,255,0.07)'}`,
                  fontWeight: statusFilter === s.value ? '700' : 'normal',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stock Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Product Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Bin Location</th>
                <th>Current Stock</th>
                <th>Min Level</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map(product => {
                const status = getStockStatus(product);
                const isNegative = product.currentStock < 0;
                return (
                  <tr
                    key={product.id}
                    style={isNegative ? {
                      background: 'rgba(239,68,68,0.08)',
                      borderLeft: '4px solid #dc2626'
                    } : {}}
                  >
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {product.productCode}
                    </td>
                    <td style={{ fontWeight: '600' }}>
                      {product.name}
                      {isNegative && (
                        <span style={{
                          marginLeft: '8px',
                          padding: '2px 8px',
                          background: '#dc2626',
                          color: 'white',
                          fontSize: '11px',
                          fontWeight: '700',
                          borderRadius: '4px'
                        }}>
                          🚨 NEGATIVE
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="badge" style={{ fontSize: '11px' }}>
                        {getCategoryLabel(product.category)}
                      </span>
                    </td>
                    <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                      {product.bin_location || '-'}
                    </td>
                    <td style={{
                      fontWeight: '700',
                      fontSize: '15px',
                      color: isNegative ? '#dc2626' : 'inherit'
                    }}>
                      {displayStock(product.currentStock, product.unit)}
                      {product.unitPerBox > 1 && (
                        <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.45)', fontWeight: '400' }}>
                          ({product.stockBoxes} boxes)
                        </div>
                      )}
                      {isNegative && (
                        <div style={{
                          fontSize: '11px',
                          color: '#fca5a5',
                          fontWeight: '600',
                          marginTop: '4px'
                        }}>
                          ⚠️ CHECK PHYSICAL COUNT
                        </div>
                      )}
                    </td>
                    <td>{displayStock(product.minStockLevel, product.unit)}</td>
                    <td>
                      {(product.status || 'active') === 'inactive' ? (
                        <span style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.3)', borderRadius: 4, color: '#94a3b8', fontWeight: 700 }}>INACTIVE</span>
                      ) : isNegative ? (
                        <span className="badge" style={{ background: '#dc2626', color: 'white', fontWeight: '700' }}>
                          NEGATIVE STOCK
                        </span>
                      ) : safetyMap[product.id] ? (
                        <span className="badge" style={{
                          background: safetyMap[product.id] === 'Critical' ? 'rgba(220,38,38,0.15)'
                            : safetyMap[product.id] === 'Attention' ? 'rgba(217,119,6,0.15)'
                            : 'rgba(22,163,74,0.15)',
                          color: safetyMap[product.id] === 'Critical' ? '#f87171'
                            : safetyMap[product.id] === 'Attention' ? '#fbbf24'
                            : '#4ade80',
                          border: `1px solid ${safetyMap[product.id] === 'Critical' ? 'rgba(220,38,38,0.3)'
                            : safetyMap[product.id] === 'Attention' ? 'rgba(217,119,6,0.3)'
                            : 'rgba(22,163,74,0.3)'}`,
                        }}>
                          {safetyMap[product.id]}
                        </span>
                      ) : (
                        <span className={`badge badge-${status.class === 'green' ? 'success' : status.class === 'yellow' ? 'warning' : 'danger'}`}>
                          {status.label}
                        </span>
                      )}
                    </td>
                    <td>
                      {['admin', 'root'].includes(user?.role) ? (
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            className="btn btn-primary"
                            onClick={() => {
                              setSelectedProduct(product);
                              setShowModal(true);
                              setType('add');
                              setQuantity('');
                              setNotes('');
                            }}
                            style={{ fontSize: '12px', padding: '6px 16px' }}
                          >
                            Adjust Stock
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => {
                              setLocationProduct(product);
                              setNewLocation(product.bin_location || '');
                              setShowLocationModal(true);
                            }}
                            style={{ fontSize: '12px', padding: '6px 16px' }}
                          >
                            📍 Edit Location
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          disabled
                          title="Admin only"
                          style={{ fontSize: '12px', padding: '6px 16px', cursor: 'not-allowed', opacity: 0.5 }}
                        >
                          🔒 Admin Only
                        </button>
                      )}
                    </td>
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

      {/* Adjust Stock Modal */}
      {showModal && selectedProduct && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Adjust Stock: {selectedProduct.name}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>

            <form onSubmit={handleAdjust}>
              <div className="card" style={{ marginBottom: '20px', background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginBottom: '4px' }}>Product Code</div>
                    <div style={{ fontFamily: 'monospace', fontWeight: '600' }}>{selectedProduct.productCode}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginBottom: '4px' }}>Category</div>
                    <div style={{ fontWeight: '600' }}>{getCategoryLabel(selectedProduct.category)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginBottom: '4px' }}>Current Stock</div>
                    <div style={{ fontWeight: '700', fontSize: '18px', color: '#2563eb' }}>
                      {displayStock(selectedProduct.currentStock, selectedProduct.unit)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginBottom: '4px' }}>Min Level</div>
                    <div style={{ fontWeight: '600' }}>{displayStock(selectedProduct.minStockLevel, selectedProduct.unit)}</div>
                  </div>
                </div>
              </div>

              <div className="form-group">
                <label>Type</label>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    type="button"
                    className={`btn ${type === 'add' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setType('add')}
                    style={{ flex: 1 }}
                  >
                    ➕ Add Stock
                  </button>
                  <button
                    type="button"
                    className={`btn ${type === 'remove' ? 'btn-danger' : 'btn-secondary'}`}
                    onClick={() => setType('remove')}
                    style={{ flex: 1 }}
                  >
                    ➖ Remove Stock
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>Quantity {selectedProduct.unit === 'mL' ? '(mL)' : `(${selectedProduct.unit})`}</label>
                <input
                  type="number"
                  className="input"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder={selectedProduct.unit === 'mL' ? 'e.g. 10000 = 10 L' : `Enter quantity in ${selectedProduct.unit}`}
                  required
                  min="1"
                />
                <MlHelper value={quantity} unit={selectedProduct.unit} />
              </div>

              <div className="form-group">
                <label>Notes (optional)</label>
                <textarea
                  className="input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add notes about this adjustment..."
                  rows="3"
                />
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Processing...' : 'Confirm Adjustment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Location Modal */}
      {showLocationModal && locationProduct && (
        <div className="modal-overlay" onClick={() => setShowLocationModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>📍 Edit Bin Location</h2>
              <button onClick={() => setShowLocationModal(false)}>&times;</button>
            </div>

            <form onSubmit={handleUpdateLocation}>
              <div style={{ marginBottom: '16px' }}>
                <strong>Product:</strong> {locationProduct.name}
              </div>

              <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                <strong>Current Location:</strong> {locationProduct.bin_location || 'Not set'}
              </div>

              <BinLocationInput
                category={locationProduct.category}
                value={newLocation}
                onChange={setNewLocation}
              />

              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowLocationModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Update Location
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
