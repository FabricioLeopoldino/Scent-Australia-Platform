import { useState, useEffect } from 'react';
import { GlowingEffect } from '../components/GlowingEffect';

export default function ColdRoomMap({ user }) {
  const [products, setProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [highlightedProduct, setHighlightedProduct] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/products?category=OILS');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load products');
      setProducts(Array.isArray(data) ? data : []);
      setLoading(false);
    } catch (error) {
      console.error('Error:', error);
      setLoading(false);
    }
  };

  const parseBinLocation = (binLocation) => {
    if (!binLocation) return null;
    const match = binLocation.match(/Aisle:?\s*(\d+),?\s*Bay:?\s*([A-Z]+|Floor),?\s*Position:?\s*(\d+)/i);
    if (match) {
      return {
        aisle: parseInt(match[1]),
        bay: match[2].toUpperCase(),
        position: parseInt(match[3])
      };
    }
    return null;
  };

  const getProductsAtLocation = (aisle, bay, position) => {
    return products.filter(p => {
      const loc = parseBinLocation(p.bin_location);
      return loc && loc.aisle === aisle && loc.bay === bay && loc.position === position;
    });
  };

  const isHighlighted = (aisle, bay, position) => {
    if (!highlightedProduct) return false;
    const loc = parseBinLocation(highlightedProduct.bin_location);
    return loc && loc.aisle === aisle && loc.bay === bay && loc.position === position;
  };

  const handleSearch = (term) => {
    setSearchTerm(term);
    if (!term.trim()) {
      setHighlightedProduct(null);
      setSearchResults([]);
      return;
    }
    const lower = term.toLowerCase();
    const found = products.filter(p =>
      (p.name ?? '').toLowerCase().includes(lower) ||
      (p.productCode ?? '').toLowerCase().includes(lower) ||
      (p.tag?.toLowerCase() ?? '').includes(lower)
    );
    setSearchResults(found);
    // Auto-highlight only if exactly 1 result
    setHighlightedProduct(found.length === 1 ? found[0] : null);
  };

  const selectProduct = (product) => {
    setHighlightedProduct(product);
    setSearchResults([]);
    setSearchTerm(product.name);
  };

  const renderPosition = (aisle, bay, position) => {
    const productsHere = getProductsAtLocation(aisle, bay, position);
    const hasProds = productsHere.length > 0;
    const highlighted = isHighlighted(aisle, bay, position);

    return (
      <div
        key={`${aisle}-${bay}-${position}`}
        onClick={() => setSelectedLocation({ aisle, bay, position, products: productsHere })}
        style={{
          padding: '10px 8px',
          background: highlighted ? '#10b981' : hasProds ? '#3b82f6' : '#2d3748',
          border: `2px solid ${highlighted ? '#059669' : hasProds ? '#2563eb' : '#4a5568'}`,
          borderRadius: '6px',
          cursor: 'pointer',
          textAlign: 'center',
          transition: 'all 0.3s',
          animation: highlighted ? 'pulse 1.5s infinite' : 'none',
          minWidth: '95px',
          boxShadow: highlighted ? '0 0 20px rgba(16, 185, 129, 0.6)' : 'none'
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: '700', color: 'white', marginBottom: '4px' }}>
          BAY: {bay} Position: {position}
        </div>
        {hasProds && (
          <div style={{
            marginTop: '4px',
            padding: '2px 6px',
            background: 'rgba(255,255,255,0.25)',
            borderRadius: '4px',
            fontSize: '9px',
            color: 'white',
            fontWeight: '600'
          }}>
            {productsHere.length} item{productsHere.length > 1 ? 's' : ''}
          </div>
        )}
      </div>
    );
  };

  // Empty placeholder cell
  const emptyCell = (key) => (
    <div key={key} style={{ minWidth: '95px' }} />
  );

  if (loading) {
    return <div className="container" style={{ paddingTop: '40px', textAlign: 'center' }}>Loading...</div>;
  }

  return (
    <div className="container" style={{ paddingTop: '40px' }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 20px rgba(16, 185, 129, 0.6); }
          50% { transform: scale(1.05); box-shadow: 0 0 30px rgba(16, 185, 129, 0.9); }
        }
      `}</style>

      <div className="page-header">
        <h2 className="page-title">🗺️ Fragrance Map</h2>
        <p style={{ color: 'rgba(232,234,242,0.45)', marginTop: '8px' }}>
          Visual warehouse location map for OILS products
        </p>
      </div>

      <div className="card" style={{ marginBottom: '24px', position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <input
          type="text"
          className="input"
          placeholder="🔍 Search product to highlight location..."
          value={searchTerm}
          onChange={(e) => handleSearch(e.target.value)}
          style={{ fontSize: '16px' }}
          autoFocus
        />
        {/* Multiple results - show dropdown list */}
        {searchResults.length > 1 && (
          <div style={{ marginTop: '8px', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '8px', overflow: 'hidden', maxHeight: '220px', overflowY: 'auto' }}>
            {searchResults.map(p => (
              <div
                key={p.id}
                onClick={() => selectProduct(p)}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  background: 'rgba(255,255,255,0.04)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
              >
                <div>
                  <div style={{ fontWeight: '600', fontSize: '13px', color: '#10b981' }}>{p.name}</div>
                  <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.45)' }}>{p.productCode}</div>
                </div>
                <div style={{ fontSize: '11px', color: '#10b981', textAlign: 'right' }}>
                  {p.bin_location || 'No location'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Single highlighted product */}
        {highlightedProduct && searchResults.length <= 1 && (
          <div style={{
            marginTop: '12px',
            padding: '12px',
            background: 'rgba(34,197,94,0.08)',
            borderRadius: '8px',
            border: '2px solid #10b981',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <div style={{ fontWeight: '700', color: '#10b981', marginBottom: '4px' }}>
                📍 {highlightedProduct.name}
              </div>
              <div style={{ fontSize: '13px', color: '#10b981' }}>
                Location: {highlightedProduct.bin_location || 'Not set'}
              </div>
            </div>
            <button
              onClick={() => { setHighlightedProduct(null); setSearchTerm(''); setSearchResults([]); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#059669', fontSize: '18px', fontWeight: '700' }}
            >×</button>
          </div>
        )}

        {/* No results */}
        {searchTerm && searchResults.length === 0 && !highlightedProduct && (
          <div style={{ marginTop: '8px', padding: '10px', color: 'rgba(232,234,242,0.3)', fontSize: '13px' }}>
            No products found for "{searchTerm}"
          </div>
        )}
      </div>

      <div className="card" style={{ background: '#1a202c', padding: '24px', position: 'relative' }}>
        {/* Legend */}
        <div style={{
          position: 'absolute',
          bottom: '16px',
          right: '16px',
          background: '#2d3748',
          padding: '12px',
          borderRadius: '8px',
          fontSize: '11px',
          color: 'white',
          zIndex: 10
        }}>
          <div style={{ fontWeight: '700', marginBottom: '8px' }}>Legend:</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <div style={{ width: '14px', height: '14px', background: '#2d3748', border: '2px solid #4a5568' }}></div>
            <span>Empty</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <div style={{ width: '14px', height: '14px', background: '#3b82f6', border: '2px solid #2563eb' }}></div>
            <span>Has Products</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '14px', height: '14px', background: '#10b981', border: '2px solid #059669' }}></div>
            <span>Highlighted</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '20px' }}>

          {/* Aisle 5 - Floor (left column) - clickable, shows all Floor products */}
          <div style={{ width: '140px', display: 'flex', alignItems: 'center' }}>
            {(() => {
              const floorProducts = products.filter(p => {
                const loc = parseBinLocation(p.bin_location);
                return loc && loc.aisle === 5;
              });
              const hasFloor = floorProducts.length > 0;
              const isFloorHighlighted = highlightedProduct && (() => {
                const loc = parseBinLocation(highlightedProduct.bin_location);
                return loc && loc.aisle === 5;
              })();
              return (
                <div
                  onClick={() => setSelectedLocation({ aisle: 5, bay: 'FLOOR', position: 'Any', products: floorProducts })}
                  style={{
                    padding: '30px 20px',
                    background: isFloorHighlighted ? '#10b981' : hasFloor ? '#3b82f6' : '#2c5282',
                    border: `3px solid ${isFloorHighlighted ? '#059669' : hasFloor ? '#2563eb' : '#2b6cb0'}`,
                    borderRadius: '12px',
                    textAlign: 'center',
                    color: 'white',
                    width: '100%',
                    cursor: 'pointer',
                    animation: isFloorHighlighted ? 'pulse 1.5s infinite' : 'none',
                    transition: 'all 0.3s'
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '8px' }}>Aisle: 5</div>
                  <div style={{ fontSize: '12px', marginBottom: '4px' }}>Bay: Floor</div>
                  <div style={{ fontSize: '10px', color: '#90cdf4', marginBottom: hasFloor ? '8px' : 0 }}>Positions: Any</div>
                  {hasFloor && (
                    <div style={{ padding: '2px 6px', background: 'rgba(255,255,255,0.25)', borderRadius: '4px', fontSize: '10px', fontWeight: '600' }}>
                      {floorProducts.length} item{floorProducts.length > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Main aisles */}
          <div style={{ flex: 1 }}>

            {/* ── AISLE 4 — Bay D — 4 cols, positions 1-15 ── */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <div style={{ background: '#047857', color: 'white', padding: '8px 16px', borderRadius: '8px', fontWeight: '700', fontSize: '13px' }}>
                  Aisle 4
                </div>
                <div style={{ color: '#a0aec0', fontSize: '12px' }}>Bay D - Positions 1-15</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', padding: '16px', background: '#b45309', borderRadius: '12px', border: '3px solid #92400e' }}>
                {emptyCell('d-empty')}
                {renderPosition(4, 'D', 9)}
                {renderPosition(4, 'D', 5)}
                {renderPosition(4, 'D', 1)}

                {renderPosition(4, 'D', 13)}
                {renderPosition(4, 'D', 10)}
                {renderPosition(4, 'D', 6)}
                {renderPosition(4, 'D', 2)}

                {renderPosition(4, 'D', 14)}
                {renderPosition(4, 'D', 11)}
                {renderPosition(4, 'D', 7)}
                {renderPosition(4, 'D', 3)}

                {renderPosition(4, 'D', 15)}
                {renderPosition(4, 'D', 12)}
                {renderPosition(4, 'D', 8)}
                {renderPosition(4, 'D', 4)}
              </div>
            </div>

            {/* ── AISLE 3 — Bay C — 3 cols, positions 1-12 ── */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <div style={{ background: '#047857', color: 'white', padding: '8px 16px', borderRadius: '8px', fontWeight: '700', fontSize: '13px' }}>
                  Aisle 3
                </div>
                <div style={{ color: '#a0aec0', fontSize: '12px' }}>Bay C - Positions 1-12</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', padding: '16px', background: '#b45309', borderRadius: '12px', border: '3px solid #92400e' }}>
                {renderPosition(3, 'C', 9)}
                {renderPosition(3, 'C', 5)}
                {renderPosition(3, 'C', 1)}

                {renderPosition(3, 'C', 10)}
                {renderPosition(3, 'C', 6)}
                {renderPosition(3, 'C', 2)}

                {renderPosition(3, 'C', 11)}
                {renderPosition(3, 'C', 7)}
                {renderPosition(3, 'C', 3)}

                {renderPosition(3, 'C', 12)}
                {renderPosition(3, 'C', 8)}
                {renderPosition(3, 'C', 4)}
              </div>
            </div>

            {/* ── AISLE 2 — Bay B — 3 cols, positions 1-12 ── */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <div style={{ background: '#047857', color: 'white', padding: '8px 16px', borderRadius: '8px', fontWeight: '700', fontSize: '13px' }}>
                  Aisle 2
                </div>
                <div style={{ color: '#a0aec0', fontSize: '12px' }}>Bay B - Positions 1-12</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', padding: '16px', background: '#b45309', borderRadius: '12px', border: '3px solid #92400e' }}>
                {renderPosition(2, 'B', 9)}
                {renderPosition(2, 'B', 5)}
                {renderPosition(2, 'B', 1)}

                {renderPosition(2, 'B', 10)}
                {renderPosition(2, 'B', 6)}
                {renderPosition(2, 'B', 2)}

                {renderPosition(2, 'B', 11)}
                {renderPosition(2, 'B', 7)}
                {renderPosition(2, 'B', 3)}

                {renderPosition(2, 'B', 12)}
                {renderPosition(2, 'B', 8)}
                {renderPosition(2, 'B', 4)}
              </div>
            </div>

            {/* ── AISLE 1 — Bay A — 4 cols, positions 1-16 ── */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <div style={{ background: '#047857', color: 'white', padding: '8px 16px', borderRadius: '8px', fontWeight: '700', fontSize: '13px' }}>
                  Aisle 1
                </div>
                <div style={{ color: '#a0aec0', fontSize: '12px' }}>Bay A - Positions 1-16</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', padding: '16px', background: '#b45309', borderRadius: '12px', border: '3px solid #92400e' }}>
                {renderPosition(1, 'A', 13)}
                {renderPosition(1, 'A', 9)}
                {renderPosition(1, 'A', 5)}
                {renderPosition(1, 'A', 1)}

                {renderPosition(1, 'A', 14)}
                {renderPosition(1, 'A', 10)}
                {renderPosition(1, 'A', 6)}
                {renderPosition(1, 'A', 2)}

                {renderPosition(1, 'A', 15)}
                {renderPosition(1, 'A', 11)}
                {renderPosition(1, 'A', 7)}
                {renderPosition(1, 'A', 3)}

                {renderPosition(1, 'A', 16)}
                {renderPosition(1, 'A', 12)}
                {renderPosition(1, 'A', 8)}
                {renderPosition(1, 'A', 4)}
              </div>
            </div>

          </div>

          {/* Cold Room label (right) */}
          <div style={{ width: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              padding: '80px 20px',
              background: '#975a16',
              border: '3px solid #744210',
              borderRadius: '12px',
              textAlign: 'center',
              color: 'white',
              fontSize: '13px',
              fontWeight: '700',
              writingMode: 'vertical-rl',
              textOrientation: 'mixed'
            }}>
              ← Cold Room
            </div>
          </div>

        </div>
      </div>

      {/* Selected location detail */}
      {selectedLocation && (
        <div className="card" style={{ marginTop: '24px', borderLeft: '4px solid #3b82f6', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '16px', fontWeight: '700', marginBottom: '16px' }}>📍 Location Details</h3>
          <div style={{ marginBottom: '16px' }}>
            <strong>Aisle:</strong> {selectedLocation.aisle} | <strong> Bay:</strong> {selectedLocation.bay} | <strong> Position:</strong> {selectedLocation.position}
          </div>
          {selectedLocation.products.length > 0 ? (
            <div>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>
                Products at this location ({selectedLocation.products.length}):
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {selectedLocation.products.map(product => (
                  <div key={product.id} style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: '700', marginBottom: '4px' }}>{product.name}</div>
                      <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)' }}>Code: {product.productCode} | Stock: {product.currentStock} {product.unit}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ color: 'rgba(232,234,242,0.45)', fontStyle: 'italic' }}>No products at this location</div>
          )}
        </div>
      )}

      {/* Products without bin location */}
      {products.filter(p => !p.bin_location).length > 0 && (
        <div className="card" style={{ marginTop: '24px', borderLeft: '4px solid #ef4444', position: 'relative', overflow: 'visible' }}>
          <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
          <h3 style={{ fontSize: '16px', fontWeight: '700', marginBottom: '16px' }}>
            ⚠️ Products Without Bin Location ({products.filter(p => !p.bin_location).length})
          </h3>
          <div style={{ fontSize: '13px', color: 'rgba(232,234,242,0.45)', marginBottom: '12px' }}>These products need to be assigned a bin location</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {products.filter(p => !p.bin_location).slice(0, 10).map(product => (
              <div key={product.id} style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: '6px', fontSize: '12px', border: '1px solid rgba(239,68,68,0.25)' }}>
                {product.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
