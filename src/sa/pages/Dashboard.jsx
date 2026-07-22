import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import {
  Star, AlertTriangle, AlertOctagon, Package, Search,
  RotateCcw, ShoppingCart, X, Info, TrendingDown,
  Download, FlaskConical, Cpu, Beaker, Factory, Truck
} from 'lucide-react';
import { exportToShopifyCSV, exportLowStockToShopifyCSV } from '../utils/shopifyExport';
import { displayStock, displayUnit } from '../utils/unitConversion';
import { isLowStock } from '../utils/stockStatus';
import { GlowingEffect } from '../components/GlowingEffect';

export default function Dashboard() {
  const showToast = useToast();
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [scentedDash, setScentedDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [watchlist, setWatchlist] = useState([]);
  const [showWatchlistModal, setShowWatchlistModal] = useState(false);
  const [modalSearch, setModalSearch] = useState('');

  useEffect(() => {
    fetchData();
    loadWatchlist();
  }, []);

  const fetchData = async () => {
    try {
      const [dashRes, productsRes, poRes, scentedRes] = await Promise.allSettled([
        fetch('/api/dashboard'),
        fetch('/api/products'),
        fetch('/api/purchase-orders'),
        fetch('/api/scented-dashboard')
      ]);
      if (dashRes.status === 'fulfilled' && dashRes.value.ok) {
        setData(await dashRes.value.json());
      }
      if (productsRes.status === 'fulfilled' && productsRes.value.ok) {
        const pd = await productsRes.value.json();
        setProducts(Array.isArray(pd) ? pd : []);
      }
      if (poRes.status === 'fulfilled' && poRes.value.ok) {
        const pd = await poRes.value.json();
        setPurchaseOrders(Array.isArray(pd) ? pd : []);
      }
      if (scentedRes.status === 'fulfilled' && scentedRes.value.ok) {
        setScentedDash(await scentedRes.value.json());
      }
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadWatchlist = () => {
    try {
      const saved = localStorage.getItem('priority_watchlist');
      if (saved) setWatchlist(JSON.parse(saved));
    } catch (error) {
      console.error('Error loading watchlist:', error);
    }
  };

  const saveWatchlist = (newWatchlist) => {
    try {
      localStorage.setItem('priority_watchlist', JSON.stringify(newWatchlist));
      setWatchlist(newWatchlist);
    } catch (error) {
      console.error('Error saving watchlist:', error);
    }
  };

  const addToWatchlist = (productId) => {
    if (watchlist.length >= 10) {
      showToast('You can only track up to 10 products in your Priority Watchlist', 'warning');
      return;
    }
    if (watchlist.includes(productId)) {
      showToast('This product is already in your watchlist', 'warning');
      return;
    }
    saveWatchlist([...watchlist, productId]);
  };

  const removeFromWatchlist = (productId) => {
    saveWatchlist(watchlist.filter(id => id !== productId));
  };

  const getStockPercentage = (current, min) => min === 0 ? 100 : Math.round((current / (min * 2)) * 100);

  const getStockStatus = (current, min) => {
    if (current <= 0) return { label: 'Out of Stock', class: 'red', badge: 'badge-danger' };
    const percentage = getStockPercentage(current, min);
    if (percentage < 30) return { label: 'Low Stock', class: 'yellow', badge: 'badge-warning' };
    if (percentage < 60) return { label: 'Reorder Soon', class: 'yellow', badge: 'badge-warning' };
    return { label: 'Healthy', class: 'green', badge: 'badge-success' };
  };

  const calculateTotalOilVolume = () =>
    products.filter(p => p.category === 'OILS').reduce((total, p) => total + (p.currentStock || 0), 0);

  const countByCategory = (category) => products.filter(p => p.category === category).length;

  const filteredModalProducts = products
    .filter(p => !watchlist.includes(p.id))
    .filter(p => {
      if (!modalSearch) return true;
      const s = modalSearch.toLowerCase();
      return (
        p.name?.toLowerCase().includes(s) ||
        p.productCode?.toLowerCase().includes(s) ||
        p.tag?.toLowerCase().includes(s) ||
        (p.supplier && p.supplier.toLowerCase().includes(s))
      );
    });

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-secondary)' }}>
          Loading dashboard...
        </div>
      </div>
    );
  }

  const lowStockProducts = products.filter(isLowStock);
  const oilsData = products.filter(p => p.category === 'OILS');
  const machinesData = products.filter(p => p.category === 'MACHINES_SPARES');
  const rawMaterialsData = products.filter(p => p.category === 'RAW_MATERIALS');
  const totalOilVolume = calculateTotalOilVolume();
  const watchlistProducts = products.filter(p => watchlist.includes(p.id));

  const statCards = [
    {
      label: 'Total Products',
      value: products.length,
      sub: `${lowStockProducts.length} need attention`,
      color: '#3b82f6',
      icon: <Factory size={18} color="#3b82f6" />,
    },
    {
      label: 'Fragrance Oils',
      value: countByCategory('OILS'),
      sub: `${(totalOilVolume / 1000).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L total volume`,
      color: '#22c55e',
      icon: <FlaskConical size={18} color="#22c55e" />,
    },
    {
      label: 'Spares',
      value: countByCategory('MACHINES_SPARES'),
      sub: `${machinesData.filter(isLowStock).length} low stock`,
      color: '#a78bfa',
      icon: <Cpu size={18} color="#a78bfa" />,
    },
    {
      label: 'Raw Materials',
      value: countByCategory('RAW_MATERIALS'),
      sub: `${rawMaterialsData.filter(isLowStock).length} low stock`,
      color: '#f59e0b',
      icon: <Beaker size={18} color="#f59e0b" />,
    },
    {
      label: 'Diffuser Machines',
      value: countByCategory('SCENT_MACHINES'),
      sub: `${products.filter(p => p.category === 'SCENT_MACHINES' && isLowStock(p)).length} low stock`,
      color: '#a78bfa',
      icon: <Cpu size={18} color="#a78bfa" />,
    },
  ];

  return (
    <div className="container" style={{ paddingTop: '32px' }}>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
            Scent Stock Manager — Overview
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="btn btn-danger"
            onClick={() => exportLowStockToShopifyCSV(products)}
            disabled={lowStockProducts.length === 0}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <TrendingDown size={14} /> Export Low Stock
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => exportToShopifyCSV(products)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(99,60,196,0.15)', border: '1px solid rgba(99,60,196,0.3)', color: '#a78bfa' }}
          >
            <Download size={14} /> Export All to Shopify
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '28px' }}>
        {statCards.map((card, i) => (
          <div key={i} className="card" style={{ borderLeft: `3px solid ${card.color}`, position: 'relative', overflow: 'visible' }}>
            <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <h3 style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {card.label}
              </h3>
              <div style={{ padding: '6px', borderRadius: 8, background: `${card.color}18` }}>
                {card.icon}
              </div>
            </div>
            <div style={{ fontSize: 36, fontWeight: 900, color: card.color, marginBottom: 6, fontFamily: 'Archivo Black, sans-serif', lineHeight: 1 }}>
              {card.value}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* SA Scented Products Widget */}
      {scentedDash && scentedDash.groups > 0 && (
        <div className="card" style={{ marginBottom: '28px', borderLeft: '3px solid #ec4899', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={40} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#f472b6', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
              <FlaskConical size={16} color="#f472b6" />
              SA Scented Products
            </h3>
            <a href="/scented-products" style={{
              fontSize: 12, color: '#f472b6', textDecoration: 'none', fontWeight: 600,
              padding: '4px 10px', borderRadius: 6, background: 'rgba(244,114,182,0.08)',
              border: '1px solid rgba(244,114,182,0.2)',
            }}>
              Manage →
            </a>
          </div>

          {/* Totals row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 18 }}>
            {[
              { label: 'Lines',        value: scentedDash.groups,     color: '#a78bfa' },
              { label: 'Products',     value: scentedDash.products,   color: '#60a5fa' },
              { label: 'Low Stock',    value: scentedDash.lowStock,   color: '#f59e0b' },
              { label: 'Out of Stock', value: scentedDash.outOfStock, color: '#ef4444' },
            ].map(s => (
              <div key={s.label} style={{
                background: 'rgba(128,128,128,0.06)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: s.color, fontFamily: 'Archivo Black, sans-serif', lineHeight: 1 }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {/* Top sold (last 30d) */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Top Sold (30 days)
              </div>
              {scentedDash.topSold.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: '8px 0' }}>
                  No sales yet
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {scentedDash.topSold.map((p, idx) => (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 10px', background: 'rgba(128,128,128,0.04)',
                      borderRadius: 6, border: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 800, color: '#94a3b8',
                          width: 18, height: 18, borderRadius: 4, background: 'rgba(148,163,184,0.15)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        }}>{idx + 1}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.name}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#10b981', flexShrink: 0, marginLeft: 8 }}>
                        {p.soldQty}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Low stock alerts */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Low Stock Alerts
              </div>
              {scentedDash.lowStockList.length === 0 ? (
                <div style={{ fontSize: 12, color: '#10b981', padding: '8px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  ✓ All scented products healthy
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {scentedDash.lowStockList.slice(0, 5).map(p => {
                    const isOut = p.currentStock <= 0;
                    return (
                      <div key={p.id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 10px',
                        background: isOut ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.06)',
                        borderRadius: 6,
                        border: `1px solid ${isOut ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)'}`,
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                          {p.name}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                          background: isOut ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                          color:      isOut ? '#fca5a5' : '#fcd34d',
                          flexShrink: 0, marginLeft: 8,
                        }}>
                          {p.currentStock} {p.unit}
                        </span>
                      </div>
                    );
                  })}
                  {scentedDash.lowStockList.length > 5 && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 2 }}>
                      +{scentedDash.lowStockList.length - 5} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Priority Watchlist */}
      <div className="card" style={{ marginBottom: '28px', borderLeft: '3px solid #3b82f6', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={40} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Star size={16} fill="#60a5fa" color="#60a5fa" />
            Priority Watchlist ({watchlistProducts.length}/10)
          </h3>
          <button
            className="btn btn-primary"
            onClick={() => { setShowWatchlistModal(true); setModalSearch(''); }}
            style={{ fontSize: 12, padding: '7px 14px' }}
          >
            + Add Product
          </button>
        </div>

        {watchlistProducts.length > 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {watchlistProducts.map(product => {
              const status = getStockStatus(product.currentStock, product.minStockLevel);
              const hasIncoming = product.incomingOrders && product.incomingOrders.length > 0;
              return (
                <div key={product.id} style={{
                  padding: '14px 16px',
                  background: 'rgba(128,128,128,0.06)',
                  borderRadius: 10,
                  border: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{product.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({product.productCode})</span>
                        <span className={`badge ${status.badge}`} style={{ fontSize: 10 }}>{status.label}</span>
                        {(product.status || 'active') === 'inactive' && (
                          <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.3)', borderRadius: 4, color: '#94a3b8', fontWeight: 700 }}>INACTIVE</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                        <span>Current: <strong style={{ color: 'var(--text-primary)' }}>{displayStock(product.currentStock, product.unit)}</strong></span>
                        <span>Min: <strong style={{ color: 'var(--text-primary)' }}>{displayStock(product.minStockLevel, product.unit)}</strong></span>
                        <span>Supplier: <strong style={{ color: 'var(--text-primary)' }}>{product.supplier || '—'}</strong></span>
                      </div>
                      {hasIncoming && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Truck size={11} /> Incoming Orders ({product.incomingOrders.length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {product.incomingOrders.map((order, idx) => (
                              <div key={idx} style={{
                                padding: '8px 12px',
                                background: 'rgba(251,191,36,0.07)',
                                border: '1px solid rgba(251,191,36,0.2)',
                                borderRadius: 8,
                                fontSize: 12,
                              }}>
                                {/* Row 1: PO number + qty */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: order.estimatedDeliveryDate || order.addedBy ? 4 : 0 }}>
                                  <Truck size={11} style={{ color: '#f59e0b', flexShrink: 0 }} />
                                  <span style={{ fontWeight: 700, color: '#fbbf24' }}>{order.orderNumber}</span>
                                  <span style={{ color: 'rgba(251,191,36,0.7)', fontWeight: 500 }}>
                                    · {displayStock(order.quantity, product.unit)}
                                  </span>
                                </div>
                                {/* Row 2: ETA */}
                                {order.estimatedDeliveryDate && (
                                  <div style={{ fontSize: 11, color: '#10b981', fontWeight: 600, marginBottom: order.addedBy ? 3 : 0, paddingLeft: 19 }}>
                                    📅 ETA: {new Date(order.estimatedDeliveryDate).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}
                                  </div>
                                )}
                                {/* Row 3: added by + when */}
                                {order.addedBy && (
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 19 }}>
                                    Added by <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{order.addedBy}</span>
                                    {order.addedAt && (
                                      <> · {new Date(order.addedAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}</>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => removeFromWatchlist(product.id)}
                      style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 6, cursor: 'pointer', color: '#f87171', padding: '4px 8px', flexShrink: 0, display: 'flex', alignItems: 'center' }}
                      title="Remove from watchlist"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{
            textAlign: 'center', padding: '40px', color: 'var(--text-muted)',
            background: 'rgba(128,128,128,0.04)', borderRadius: 10,
            border: '2px dashed var(--border)',
          }}>
            <Star size={36} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>No products in your watchlist</div>
            <div style={{ fontSize: 12 }}>Click "+ Add Product" to track your most important products</div>
          </div>
        )}
      </div>

      {/* Negative Stock Alerts */}
      {products.filter(p => p.currentStock < 0).length > 0 && (
        <div className="card" style={{
          marginBottom: 28,
          borderLeft: '3px solid #ef4444',
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.2)',
          position: 'relative', overflow: 'visible',
        }}>
          <GlowingEffect spread={35} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: '#f87171', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertOctagon size={18} color="#f87171" />
            Negative Stock Alerts ({products.filter(p => p.currentStock < 0).length}) — Check Physical Count
          </h3>
          <div style={{
            padding: '12px 16px', background: 'rgba(239,68,68,0.08)', borderRadius: 8,
            marginBottom: 16, border: '1px solid rgba(239,68,68,0.15)',
          }}>
            <div style={{ fontSize: 12, color: '#fca5a5', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} /> These products have negative stock — indicating one of:
            </div>
            <ul style={{ fontSize: 12, color: 'rgba(252,165,165,0.7)', marginLeft: 20, marginTop: 4, marginBottom: 0, lineHeight: 1.8 }}>
              <li>Physical count discrepancy</li>
              <li>Missing stock entry in system</li>
              <li>Unregistered removal</li>
              <li>Shopify/System sync issue</li>
            </ul>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {products.filter(p => p.currentStock < 0).map(product => (
              <div key={product.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px', background: 'rgba(128,128,128,0.06)', borderRadius: 8,
                border: '1px solid rgba(239,68,68,0.25)',
              }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 14, color: 'var(--text-primary)' }}>{product.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {product.productCode} • {product.category === 'MACHINES_SPARES' ? 'Spares' : product.category === 'RAW_MATERIALS' ? 'Raw Materials' : 'Oils'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 900, color: '#f87171', fontSize: 18, marginBottom: 4 }}>
                    {displayStock(product.currentStock, product.unit)}
                  </div>
                  <div style={{ fontSize: 10, color: '#fca5a5', fontWeight: 700, background: 'rgba(239,68,68,0.15)', padding: '2px 8px', borderRadius: 4, display: 'inline-block' }}>
                    {displayStock(Math.abs(product.currentStock), product.unit)} MISSING
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Low Stock Alerts */}
      {lowStockProducts.length > 0 && (
        <div className="card" style={{ marginBottom: 28, borderLeft: '3px solid #f59e0b', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={35} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} color="#fbbf24" />
            Low Stock Alerts ({lowStockProducts.length})
          </h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {lowStockProducts.slice(0, 10).map(product => {
              const status = getStockStatus(product.currentStock, product.minStockLevel);
              return (
                <div key={product.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 16px', background: 'rgba(245,158,11,0.06)', borderRadius: 8,
                  border: '1px solid rgba(245,158,11,0.15)',
                }}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13, color: 'var(--text-primary)' }}>{product.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {product.productCode} • {product.category === 'MACHINES_SPARES' ? 'Spares' : product.category === 'RAW_MATERIALS' ? 'Raw Materials' : 'Oils'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, color: '#f87171', fontSize: 14 }}>{displayStock(product.currentStock, product.unit)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Min: {displayStock(product.minStockLevel, product.unit)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Incoming Orders */}
      <div className="card" style={{ marginTop: 24, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={40} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Truck size={16} />
          Incoming Orders
          {purchaseOrders.length > 0 && (
            <span style={{ marginLeft: 4, fontSize: 12, fontWeight: 700, background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 20, padding: '1px 8px' }}>
              {purchaseOrders.length}
            </span>
          )}
        </h3>
        {purchaseOrders.length > 0 ? (
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>PO #</th>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Qty Ordered</th>
                  <th>Qty Received</th>
                  <th>Status</th>
                  <th>ETA</th>
                  <th>Supplier</th>
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.map(po => {
                  const remaining = parseFloat(po.quantity) - (parseFloat(po.quantity_received) || 0);
                  const isPartial = po.status === 'partial';
                  const isOverdue = po.estimated_delivery_date && new Date(po.estimated_delivery_date) < new Date();
                  return (
                    <tr key={po.id}>
                      <td style={{ fontWeight: 700, fontSize: 13 }}>{po.order_number}</td>
                      <td style={{ fontWeight: 600 }}>{po.product_name}</td>
                      <td>
                        <span className="badge badge-secondary" style={{ fontSize: 10 }}>
                          {po.category === 'MACHINES_SPARES' ? 'Spares' :
                           po.category === 'RAW_MATERIALS'   ? 'Raw Materials' :
                           po.category === 'SCENT_MACHINES'  ? 'Diffusers' : 'Oils'}
                        </span>
                      </td>
                      <td>{displayStock(po.quantity, po.unit)}</td>
                      <td style={{ color: isPartial ? '#fbbf24' : 'var(--text-muted)' }}>
                        {parseFloat(po.quantity_received) > 0 ? displayStock(po.quantity_received, po.unit) : '—'}
                      </td>
                      <td>
                        <span className={`badge ${isPartial ? 'badge-warning' : 'badge-secondary'}`} style={{ fontSize: 10 }}>
                          {isPartial ? `Partial (${displayStock(remaining, po.unit)} left)` : 'Pending'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: isOverdue ? '#f87171' : 'var(--text-secondary)', fontWeight: isOverdue ? 700 : 400 }}>
                        {po.estimated_delivery_date
                          ? new Date(po.estimated_delivery_date).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
                          : '—'}
                        {isOverdue && <span style={{ marginLeft: 4 }}>⚠️</span>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{po.supplier || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            No incoming orders
          </div>
        )}
      </div>

      {/* Add to Watchlist Modal */}
      {showWatchlistModal && (
        <div className="modal-overlay" onClick={() => { setShowWatchlistModal(false); setModalSearch(''); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Star size={16} fill="#60a5fa" color="#60a5fa" /> Add to Priority Watchlist
              </h2>
              <button className="modal-close" onClick={() => { setShowWatchlistModal(false); setModalSearch(''); }}>×</button>
            </div>

            <div style={{ padding: '16px 32px 0' }}>
              <div style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(59,130,246,0.08)', borderRadius: 8, fontSize: 12, color: '#93c5fd', border: '1px solid rgba(59,130,246,0.15)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                Select up to 10 products you want to monitor closely (best sellers, critical items, etc.)
              </div>
              <div style={{ marginBottom: 14, position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="input"
                  placeholder="Search by name, code, tag, or supplier..."
                  value={modalSearch}
                  onChange={e => setModalSearch(e.target.value)}
                  autoFocus
                  style={{ paddingLeft: 36, fontSize: 13 }}
                />
                {modalSearch && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    Found {filteredModalProducts.length} product{filteredModalProducts.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
            </div>

            <div style={{ maxHeight: 380, overflowY: 'auto', padding: '0 32px' }}>
              {filteredModalProducts.length > 0 ? (
                filteredModalProducts.map(product => (
                  <div
                    key={product.id}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s', borderRadius: 4 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(128,128,128,0.07)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    onClick={() => { addToWatchlist(product.id); if (watchlist.length >= 9) { setShowWatchlistModal(false); setModalSearch(''); } }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 3, fontSize: 13 }}>{product.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {product.productCode} • {product.category}{product.supplier && ` • ${product.supplier}`}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: 11, padding: '5px 12px' }}
                      onClick={e => { e.stopPropagation(); addToWatchlist(product.id); if (watchlist.length >= 9) { setShowWatchlistModal(false); setModalSearch(''); } }}
                    >
                      + Add
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>No products found</div>
                  <div style={{ fontSize: 11 }}>Try a different search term</div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => { setShowWatchlistModal(false); setModalSearch(''); }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
