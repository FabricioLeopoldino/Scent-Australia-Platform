import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';
import { isLowStock } from '../utils/stockStatus';

export default function DiffuserMachineBOM({ user }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [bom, setBom] = useState({});
  const [selectedMachine, setSelectedMachine] = useState('wifi_pro_black');
  const [products, setProducts] = useState([]);
  const [machineSpares, setMachineSpares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingComponent, setEditingComponent] = useState(null);
  const [formData, setFormData] = useState({
    componentCode: '',
    componentName: '',
    quantity: 1
  });

  // Fixed machine list
  const machines = [
    { type: 'wifi_pro_black', name: 'ScentPro - Wi-Fi Pro Diffuser (Black)', color: '#1f2937' },
    { type: 'wifi_pro_white', name: 'ScentPro - Wi-Fi Pro Diffuser (White)', color: '#9ca3af' },
    { type: 'medium_700_white', name: 'ScentPro - 700 Medium Diffuser (White)', color: '#ec4899' },
    { type: 'medium_700_black', name: 'ScentPro - 700 Medium Diffuser (Black)', color: '#10b981' },
    { type: 'hvac_scentlux', name: 'ScentLux - HVAC Diffuser', color: '#3b82f6' }
  ];

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [bomRes, productsRes] = await Promise.all([
        fetch('/api/diffuser-bom'),
        fetch('/api/products')
      ]);

      if (!bomRes.ok || !productsRes.ok) throw new Error('Failed to load BOM data');
      const bomData = await bomRes.json();
      const productsData = await productsRes.json();

      setBom(bomData && typeof bomData === 'object' && !Array.isArray(bomData) ? bomData : {});
      const safeProducts = Array.isArray(productsData) ? productsData : [];
      setProducts(safeProducts);
      setMachineSpares(safeProducts.filter(p => p.category === 'MACHINES_SPARES'));
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getProductByCode = (code) => {
    return products.find(p => p.productCode === code);
  };

  const getMachineName = (type) => {
    const machine = machines.find(m => m.type === type);
    return machine ? machine.name : type;
  };

  const getMachineColor = (type) => {
    const machine = machines.find(m => m.type === type);
    return machine ? machine.color : '#667eea';
  };

  const handleAddComponent = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch('/api/diffuser-bom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineType: selectedMachine,
          componentCode: formData.componentCode,
          componentName: formData.componentName,
          quantity: formData.quantity
        })
      });

      if (res.ok) {
        const data = await res.json();
        setBom(prev => ({ ...prev, [selectedMachine]: data.bom }));
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
      const res = await fetch(`/api/diffuser-bom/${editingComponent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          componentName: formData.componentName,
          quantity: formData.quantity
        })
      });

      if (res.ok) {
        const data = await res.json();
        setBom(prev => ({ ...prev, [selectedMachine]: data.bom }));
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

  const handleDeleteComponent = async (id) => {
    setConfirmState({ message: 'Are you sure you want to remove this component from the BOM?', onConfirm: async () => {
      setConfirmState(null);
      try {
        const res = await fetch(`/api/diffuser-bom/${id}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          const data = await res.json();
          setBom(prev => ({ ...prev, [selectedMachine]: data.bom }));
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

  const handleMachineSpareSelect = (e) => {
    const code = e.target.value;
    const spare = machineSpares.find(s => s.productCode === code);
    if (spare) {
      setFormData({
        componentCode: spare.productCode,
        componentName: spare.name,
        quantity: 1
      });
    }
  };

  const currentBOM = bom[selectedMachine] || [];
  // Diffuser BOM edits drive spare-part debits — backend requires root (not admin).
  // Was showing admin an enabled Add/Edit/Remove that 403'd on submit.
  const isAdmin = user?.role === 'root';

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '40px' }}>
        <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.45)' }}>
          Loading Diffuser Machine BOM data...
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">DIFFUSER MACHINE BOM</h2>
          <p>Bill of Materials for each diffuser machine type</p>
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

      {/* Machine Selector */}
      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {machines.map(machine => (
            <button
              key={machine.type}
              className={`btn ${selectedMachine === machine.type ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setSelectedMachine(machine.type)}
              style={selectedMachine === machine.type ? {
                background: getMachineColor(machine.type),
                borderColor: getMachineColor(machine.type)
              } : {}}
            >
              {machine.name}
            </button>
          ))}
        </div>
      </div>

      {/* Machine Info */}
      <div className="card" style={{ marginBottom: '24px', background: `linear-gradient(135deg, ${getMachineColor(selectedMachine)}15 0%, ${getMachineColor(selectedMachine)}05 100%)`, position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{
            width: '60px',
            height: '60px',
            borderRadius: '12px',
            background: getMachineColor(selectedMachine),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontWeight: '900',
            fontSize: '24px'
          }}>
            {currentBOM.length}
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', marginBottom: '4px' }}>
              {getMachineName(selectedMachine)}
            </h3>
            <p style={{ margin: 0, fontSize: '14px', color: 'rgba(232,234,242,0.45)' }}>
              {currentBOM.length} component{currentBOM.length !== 1 ? 's' : ''} required
            </p>
          </div>
        </div>
      </div>

      {/* Components Table */}
      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        {currentBOM.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: 'rgba(232,234,242,0.3)' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📦</div>
            <p style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>No components yet</p>
            <p style={{ fontSize: '14px' }}>Add components to build the BOM for this machine</p>
          </div>
        ) : (
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '60px' }}>#</th>
                  <th>Component Code</th>
                  <th>Component Name</th>
                  <th style={{ width: '120px' }}>Quantity</th>
                  <th style={{ width: '120px' }}>Current Stock</th>
                  <th style={{ width: '120px' }}>Status</th>
                  {isAdmin && <th style={{ width: '180px' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {currentBOM.map((item) => {
                  const product = getProductByCode(item.componentCode);
                  const currentStock = product ? parseFloat(product.currentStock) : 0;
                  const minStock = product ? parseFloat(product.minStockLevel) : 0;
                  const isOut = product && currentStock <= 0;
                  const isLow = product && !isOut && currentStock <= minStock;

                  return (
                    <tr key={item.id}>
                      <td>
                        <div style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '8px',
                          background: getMachineColor(selectedMachine) + '20',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: '900',
                          color: getMachineColor(selectedMachine)
                        }}>
                          {item.seq}
                        </div>
                      </td>
                      <td>
                        <span style={{
                          fontFamily: 'monospace',
                          background: 'rgba(255,255,255,0.03)',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          fontSize: '12px'
                        }}>
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
                              onClick={() => handleDeleteComponent(item.id)}
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
              return product && isLowStock(product);
            }).length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Low Stock Components</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#8b5cf6', marginBottom: '8px' }}>
            {machines.length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Total Machines</div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <div style={{ fontSize: '32px', fontWeight: '900', color: '#10b981', marginBottom: '8px' }}>
            {machineSpares.length}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', fontWeight: '600' }}>Available Spares</div>
        </div>
      </div>

      {/* Add Component Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Component to {getMachineName(selectedMachine)}</h2>
              <button className="modal-close" onClick={() => setShowAddModal(false)}>×</button>
            </div>

            <form onSubmit={handleAddComponent}>
              <div className="form-group">
                <label>Select Machine Spare</label>
                <select
                  className="input"
                  onChange={handleMachineSpareSelect}
                  value={formData.componentCode}
                >
                  <option value="">-- Select a Machine Spare --</option>
                  {machineSpares.map(spare => (
                    <option key={spare.productCode} value={spare.productCode}>
                      {spare.productCode} - {spare.name}
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
                  placeholder="e.g., SA_MAC_00010"
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
                  placeholder="e.g., USB Cable"
                  required
                />
              </div>

              <div className="form-group">
                <label>Quantity per Machine</label>
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
                <label>Quantity per Machine</label>
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
