import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';
import { LiquidMetalButton } from '../components/LiquidMetalButton';

export default function MachineInventory({ user }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [machines, setMachines] = useState([]);
  const [filteredMachines, setFilteredMachines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [subCategoryFilter, setSubCategoryFilter] = useState('ALL');
  const [colorFilter, setColorFilter] = useState('ALL');
  const [locationFilter, setLocationFilter] = useState('ALL');

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingMachine, setEditingMachine] = useState(null);
  const [incomingMachine, setIncomingMachine] = useState(null);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [receivingOrder, setReceivingOrder] = useState(null);

  const [formData, setFormData] = useState({
    name: '',
    sub_category: '',
    color: '',
    location: '',
    bin_location: '',
    supplier: '',
    supplier_code: '',
    productCode: '',
    tag: '',
    currentStock: 0,
    minStockLevel: 0,
    shopifySkus: ''
  });

  const [receivingOption, setReceivingOption] = useState('full');
  const [receiveFormData, setReceiveFormData] = useState({
    quantityReceived: '',
    notes: ''
  });

  useEffect(() => {
    fetchMachines();
  }, []);

  useEffect(() => {
    filterMachines();
  }, [machines, searchTerm, subCategoryFilter, colorFilter, locationFilter]);

  const fetchMachines = async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load machines');
      const machineData = (Array.isArray(data) ? data : []).filter(p => p.category === 'SCENT_MACHINES');
      setMachines(machineData);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching machines:', error);
      setLoading(false);
    }
  };

  const filterMachines = () => {
    let filtered = machines;

    if (subCategoryFilter !== 'ALL') {
      filtered = filtered.filter(m => m.sub_category === subCategoryFilter);
    }

    if (colorFilter !== 'ALL') {
      filtered = filtered.filter(m => m.color === colorFilter);
    }

    if (locationFilter !== 'ALL') {
      filtered = filtered.filter(m => m.bin_location === locationFilter);
    }

    if (searchTerm) {
      filtered = filtered.filter(m =>
        (m.name?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
        (m.productCode?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
        (m.tag?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
        (m.supplier && m.supplier.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (m.sub_category && m.sub_category.toLowerCase().includes(searchTerm.toLowerCase()))
      );
    }

    setFilteredMachines(filtered);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const url = editingMachine
        ? `/api/products/${editingMachine.id}`
        : '/api/products';

      const method = editingMachine ? 'PUT' : 'POST';

      // Convert shopifySkus string to object
      let skusObject = {};
      if (formData.shopifySkus && formData.shopifySkus.trim()) {
        const skusArray = formData.shopifySkus.split(',').map(s => s.trim()).filter(Boolean);
        skusArray.forEach(sku => {
          skusObject[sku] = sku;
        });
      }

      // ENSURE fields are strings (not undefined/null)
      const sub_category = formData.sub_category || '';
      const color = formData.color || '';
      const location = formData.location || '';

      const payload = {
        name: formData.name,
        category: 'SCENT_MACHINES',
        unit: 'units',
        productCode: formData.productCode || '',
        tag: formData.tag || '',
        currentStock: parseFloat(formData.currentStock) || 0,
        minStockLevel: parseFloat(formData.minStockLevel) || 0,
        supplier: formData.supplier || '',
        supplier_code: formData.supplier_code || '',
        shopifySkus: skusObject,
        sub_category: sub_category,
        color: color,
        location: location,
        bin_location: formData.bin_location || ''
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        showToast(editingMachine ? 'Machine updated!' : 'Machine added!', 'success');
        setShowAddModal(false);
        setEditingMachine(null);
        resetForm();
        fetchMachines();
      }
    } catch (error) {
      showToast('Error saving machine: ' + error.message, 'error');
    }
  };

  const handleDelete = async (machineId) => {
    setConfirmState({ message: 'Are you sure you want to delete this machine?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/products/${machineId}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          showToast('Machine deleted!', 'success');
          fetchMachines();
        }
      } catch (error) {
        showToast('Error deleting machine: ' + error.message, 'error');
      }
    }});
  };

  const handleEdit = (machine) => {
    setEditingMachine(machine);
    setFormData({
      name: machine.name,
      sub_category: machine.sub_category || '',
      color: machine.color || '',
      location: machine.location || '',
      bin_location: machine.bin_location || '',
      supplier: machine.supplier || '',
      supplier_code: machine.supplier_code || '',
      productCode: machine.productCode,
      tag: machine.tag,
      currentStock: machine.currentStock,
      minStockLevel: machine.minStockLevel,
      shopifySkus: Object.keys(machine.shopifySkus || {}).join(', ') || ''
    });
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      sub_category: '',
      color: '',
      location: '',
      bin_location: '',
      supplier: '',
      supplier_code: '',
      productCode: '',
      tag: '',
      currentStock: 0,
      minStockLevel: 0,
      shopifySkus: ''
    });
  };

  const handleClearIncoming = async (poId) => {
    if (!poId) { showToast('Cannot clear: order ID missing', 'error'); return; }
    setConfirmState({ message: 'Clear this incoming order?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/purchase-orders/${poId}?userId=${user?.id || ''}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Incoming order cleared!', 'success');
          fetchMachines();
        }
      } catch (error) {
        showToast('Error clearing incoming order: ' + error.message, 'error');
      }
    }});
  };

  const handleOpenReceiveModal = (machine, order) => {
    setIncomingMachine(machine);
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
          receivedBy: user?.username || user?.name || 'admin'
        })
      });

      if (res.ok) {
        const data = await res.json();
        showToast(`Stock updated successfully! New stock: ${data.newStock} units`, 'success');
        setShowReceiveModal(false);
        setIncomingMachine(null);
        setReceivingOrder(null);
        setReceivingOption('full');
        setReceiveFormData({ quantityReceived: '', notes: '' });
        fetchMachines();
      } else {
        const error = await res.json();
        showToast(error.error || 'Error receiving incoming order', 'error');
      }
    } catch (error) {
      showToast('Error receiving incoming order: ' + error.message, 'error');
    }
  };

  const getStockStatus = (machine) => {
    if (machine.currentStock < 0) {
      return { label: 'Negative Stock', color: 'red' };
    }
    if (machine.currentStock === 0) {
      return { label: 'Out of Stock', color: 'red' };
    }
    if (machine.currentStock < machine.minStockLevel) {
      return { label: 'Low Stock', color: 'yellow' };
    }
    return { label: 'In Stock', color: 'green' };
  };

  const uniqueSubCategories = [...new Set(machines.map(m => m.sub_category).filter(Boolean))];
  const uniqueColors = [...new Set(machines.map(m => m.color).filter(Boolean))];
  const uniqueBinLocations = [...new Set(machines.map(m => m.bin_location).filter(Boolean))];

  const totalMachines = machines.length;
  const inStock = machines.filter(m => m.currentStock > 0).length;
  const lowStock = machines.filter(m => m.currentStock > 0 && m.currentStock < m.minStockLevel).length;
  const outOfStock = machines.filter(m => m.currentStock === 0).length;

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading machines...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <h2 className="page-title">Diffusers</h2>
        <p style={{ color: 'rgba(232,234,242,0.45)', marginTop: '8px' }}>Manage all Scent diffusion machines</p>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <div className="card" style={{ borderLeft: '4px solid #3b82f6', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'rgba(232,234,242,0.45)', marginBottom: '12px', textTransform: 'uppercase' }}>
            Total Machines
          </h3>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#3b82f6' }}>
            {totalMachines}
          </div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #10b981', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'rgba(232,234,242,0.45)', marginBottom: '12px', textTransform: 'uppercase' }}>
            In Stock
          </h3>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#10b981' }}>
            {inStock}
          </div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #f59e0b', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'rgba(232,234,242,0.45)', marginBottom: '12px', textTransform: 'uppercase' }}>
            Low Stock
          </h3>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#f59e0b' }}>
            {lowStock}
          </div>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #ef4444', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '14px', fontWeight: '700', color: 'rgba(232,234,242,0.45)', marginBottom: '12px', textTransform: 'uppercase' }}>
            Out of Stock
          </h3>
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#ef4444' }}>
            {outOfStock}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 12, marginBottom: '24px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
        <LiquidMetalButton label="🧩 Diffuser BOM" width={168} onClick={() => window.location.href = '/diffuser-bom'} />
        {['admin', 'root'].includes(user?.role) && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditingMachine(null);
              resetForm();
              setShowAddModal(true);
            }}
          >
            + Add Machine
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div>
            <label style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px', display: 'block' }}>
              Search
            </label>
            <input
              type="text"
              className="input"
              placeholder="Search by name, code, supplier..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div>
            <label style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px', display: 'block' }}>
              SubCategory
            </label>
            <select
              className="input"
              value={subCategoryFilter}
              onChange={(e) => setSubCategoryFilter(e.target.value)}
            >
              <option value="ALL">All SubCategories</option>
              {uniqueSubCategories.map(sub => (
                <option key={sub} value={sub}>{sub}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px', display: 'block' }}>
              Color
            </label>
            <select
              className="input"
              value={colorFilter}
              onChange={(e) => setColorFilter(e.target.value)}
            >
              <option value="ALL">All Colors</option>
              {uniqueColors.map(color => (
                <option key={color} value={color}>{color}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(232,234,242,0.45)', marginBottom: '8px', display: 'block' }}>
              Bin Location
            </label>
            <select
              className="input"
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
            >
              <option value="ALL">All Bin Locations</option>
              {uniqueBinLocations.map(loc => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Machines Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>SubCategory</th>
                <th>Name</th>
                <th>Color</th>
                <th>Bin Location</th>
                <th>Shopify SKU</th>
                <th>Stock</th>
                <th>Min Level</th>
                <th>Status</th>
                <th>Incoming Orders</th>
                {['admin', 'root'].includes(user?.role) && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredMachines.map(machine => {
                const status = getStockStatus(machine);
                const isNegative = machine.currentStock < 0;
                return (
                  <tr
                    key={machine.id}
                    style={isNegative ? {
                      background: 'rgba(239,68,68,0.08)',
                      borderLeft: '4px solid #dc2626'
                    } : {}}
                  >
                    <td style={{ fontSize: '13px' }}>{machine.supplier || '-'}</td>
                    <td>
                      {machine.sub_category ? (
                        <span className="badge" style={{ background: '#8b5cf6', color: 'white', fontSize: '11px' }}>
                          {machine.sub_category}
                        </span>
                      ) : (
                        <span style={{ color: 'rgba(232,234,242,0.3)', fontSize: '12px' }}>-</span>
                      )}
                    </td>
                    <td style={{ fontWeight: '600' }}>
                      {machine.name}
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
                      {machine.color ? (
                        <span style={{
                          padding: '4px 8px',
                          background: 'rgba(255,255,255,0.03)',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: '600'
                        }}>
                          {machine.color}
                        </span>
                      ) : '-'}
                    </td>
                    <td style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)' }}>
                      {machine.bin_location || '-'}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {Object.keys(machine.shopifySkus || {}).join(', ') || '-'}
                    </td>
                    <td>
                      <span style={{
                        fontWeight: isNegative ? '900' : '600',
                        color: isNegative ? '#dc2626' : 'inherit',
                        fontSize: isNegative ? '15px' : 'inherit'
                      }}>
                        {machine.currentStock} units
                      </span>
                      {isNegative && (
                        <div style={{
                          fontSize: '11px',
                          color: '#fca5a5',
                          fontWeight: '600',
                          marginTop: '4px'
                        }}>
                          ⚠️ {Math.abs(machine.currentStock)} units MISSING
                        </div>
                      )}
                    </td>
                    <td>{machine.minStockLevel} units</td>
                    <td>
                      {(machine.status || 'active') === 'inactive' ? (
                        <span style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.3)', borderRadius: 4, color: '#94a3b8', fontWeight: 700 }}>INACTIVE</span>
                      ) : isNegative ? (
                        <span className="badge" style={{
                          background: '#dc2626',
                          color: 'white',
                          fontWeight: '700'
                        }}>
                          NEGATIVE STOCK
                        </span>
                      ) : (
                        <span className={status.color} style={{ fontWeight: '600' }}>{status.label}</span>
                      )}
                    </td>
                    <td>
                      {machine.incomingOrders && machine.incomingOrders.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {machine.incomingOrders.map((order, idx) => (
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
                                  ({order.quantity} units)
                                </span>
                                {['admin', 'root'].includes(user?.role) && (
                                  <>
                                    <button
                                      onClick={() => handleOpenReceiveModal(machine, order)}
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
                    {['admin', 'root'].includes(user?.role) && (
                      <td>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleEdit(machine)}
                            style={{ fontSize: '12px', padding: '6px 12px' }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => handleDelete(machine.id)}
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
          Showing {filteredMachines.length} of {machines.length} machines
        </div>
      </div>

      {/* Add/Edit Machine Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
            <div className="modal-header">
              <h2>{editingMachine ? 'Edit Machine' : 'Add New Machine'}</h2>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Machine Name *</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>SubCategory</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.sub_category}
                    onChange={(e) => setFormData({...formData, sub_category: e.target.value})}
                    placeholder="e.g., HVAC, Scentpro, Scentlite"
                  />
                </div>

                <div className="form-group">
                  <label>Color</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.color}
                    onChange={(e) => setFormData({...formData, color: e.target.value})}
                    placeholder="e.g., Black, White"
                  />
                </div>

                <div className="form-group">
                  <label>Bin Location (Physical Warehouse)</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.bin_location}
                    onChange={(e) => setFormData({...formData, bin_location: e.target.value})}
                    placeholder="e.g., Shelf D-5, Production Floor, Warehouse Section B"
                  />
                  <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.45)', marginTop: '4px' }}>
                    Physical warehouse location for inventory control
                  </div>
                </div>

                <div className="form-group">
                  <label>Supplier</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.supplier}
                    onChange={(e) => setFormData({...formData, supplier: e.target.value})}
                    placeholder="e.g., ECO, ov-10"
                  />
                </div>

                <div className="form-group">
                  <label>Product Code</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.productCode}
                    onChange={(e) => setFormData({...formData, productCode: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Tag</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.tag}
                    onChange={(e) => setFormData({...formData, tag: e.target.value})}
                  />
                </div>

                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Shopify SKUs (comma-separated)</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.shopifySkus}
                    onChange={(e) => setFormData({...formData, shopifySkus: e.target.value})}
                    placeholder="e.g., SA_0001, SA_0002"
                  />
                  <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.45)', marginTop: '4px' }}>
                    Enter multiple SKUs separated by commas
                  </div>
                </div>

                <div className="form-group">
                  <label>Current Stock</label>
                  <input
                    type="number"
                    className="input"
                    value={formData.currentStock}
                    onChange={(e) => setFormData({...formData, currentStock: parseFloat(e.target.value) || 0})}
                    min="0"
                  />
                </div>

                <div className="form-group">
                  <label>Min Stock Level</label>
                  <input
                    type="number"
                    className="input"
                    value={formData.minStockLevel}
                    onChange={(e) => setFormData({...formData, minStockLevel: parseFloat(e.target.value) || 0})}
                    min="0"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingMachine ? 'Update Machine' : 'Add Machine'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Receive Incoming Order Modal */}
      {showReceiveModal && incomingMachine && receivingOrder && (
        <div className="modal-overlay" onClick={() => setShowReceiveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Receive Purchase Order</h2>
              <button className="modal-close" onClick={() => setShowReceiveModal(false)}>×</button>
            </div>

            <form onSubmit={handleReceiveIncoming}>
              <div style={{ marginBottom: '20px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                <div style={{ fontWeight: '600', marginBottom: '4px' }}>Machine:</div>
                <div style={{ fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>{incomingMachine.name}</div>
                <div style={{ fontSize: '12px', color: 'rgba(232,234,242,0.3)', marginTop: '4px' }}>
                  PO: {receivingOrder.orderNumber} • Expected: {receivingOrder.quantity} units
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
                    <span>Yes, received {receivingOrder.quantity} units in full</span>
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
                    <span>No, received a different quantity</span>
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
                    min="0"
                    required
                  />
                </div>
              )}

              <div className="form-group">
                <label>Notes (Optional)</label>
                <textarea
                  className="input"
                  value={receiveFormData.notes}
                  onChange={(e) => setReceiveFormData({...receiveFormData, notes: e.target.value})}
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
                  <li>Stock will be updated automatically</li>
                  <li>Transaction will be created in History</li>
                  <li>Incoming order badge will be removed</li>
                </ul>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowReceiveModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ background: '#10b981' }}>
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
    </div>
  );
}
