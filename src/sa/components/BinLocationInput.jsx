// BinLocationInput.jsx - Smart bin location helper with dropdowns
// Use in: Products, Stock Management, Machine Inventory

import { useState, useEffect } from 'react';

const AISLE_CONFIG = {
  1: { bay: 'A', positions: 16 },
  2: { bay: 'B', positions: 12 },
  3: { bay: 'C', positions: 12 },
  4: { bay: 'D', positions: 15 },
  5: { bay: 'Floor', positions: 0 }, // Floor = any position
};

function parseExisting(value) {
  if (!value) return { aisle: '', bay: '', position: '' };
  const match = value.match(/Aisle:?\s*(\d+),?\s*Bay:?\s*([A-Z]+|Floor),?\s*Position:?\s*(\w+)/i);
  if (match) return { aisle: match[1], bay: match[2].toUpperCase(), position: match[3] };
  return { aisle: '', bay: '', position: '' };
}

export default function BinLocationInput({ value, onChange, disabled = false }) {
  const parsed = parseExisting(value);
  const [aisle, setAisle] = useState(parsed.aisle || '');
  const [position, setPosition] = useState(parsed.position || '');
  const [showHelper, setShowHelper] = useState(false);

  const config = aisle ? AISLE_CONFIG[parseInt(aisle)] : null;
  const bay = config?.bay || '';
  const isFloor = bay === 'Floor';
  const maxPositions = config?.positions || 0;

  // Sync to parent whenever aisle/position changes
  useEffect(() => {
    if (!aisle) return;
    const formatted = isFloor
      ? `Aisle: ${aisle}, Bay: Floor, Position: Any`
      : position
        ? `Aisle: ${aisle}, Bay: ${bay}, Position: ${position}`
        : '';
    if (formatted !== value) onChange(formatted);
  }, [aisle, position, onChange]);

  const handleAisleChange = (val) => {
    setAisle(val);
    setPosition('');
  };

  const handleClear = () => {
    setAisle('');
    setPosition('');
    onChange('');
  };

  return (
    <div className="form-group">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <label style={{ margin: 0 }}>Bin Location</label>
        <button
          type="button"
          onClick={() => setShowHelper(!showHelper)}
          disabled={disabled}
          style={{
            fontSize: '11px',
            padding: '2px 10px',
            borderRadius: '20px',
            border: '1px solid rgba(34,197,94,0.4)',
            background: showHelper ? 'rgba(34,197,94,0.15)' : 'transparent',
            color: '#10b981',
            cursor: 'pointer',
            fontWeight: '600',
            transition: 'all 0.2s'
          }}
        >
          {showHelper ? 'Manual' : 'Helper'}
        </button>
      </div>

      {showHelper ? (
        <div style={{
          border: '1px solid rgba(34,197,94,0.25)',
          borderRadius: '8px',
          padding: '12px',
          background: 'rgba(34,197,94,0.04)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          {/* Row: Aisle + Bay + Position */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            {/* Aisle */}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.5)', marginBottom: '4px', fontWeight: '600' }}>AISLE</div>
              <select
                className="input"
                value={aisle}
                onChange={(e) => handleAisleChange(e.target.value)}
                disabled={disabled}
                style={{ width: '100%' }}
              >
                <option value="">Select...</option>
                {Object.keys(AISLE_CONFIG).map(a => (
                  <option key={a} value={a}>Aisle {a}</option>
                ))}
              </select>
            </div>

            {/* Bay (auto) */}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.5)', marginBottom: '4px', fontWeight: '600' }}>BAY (auto)</div>
              <input
                className="input"
                value={bay}
                readOnly
                style={{ width: '100%', opacity: bay ? 1 : 0.4, cursor: 'default' }}
                placeholder="—"
              />
            </div>

            {/* Position */}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '11px', color: 'rgba(232,234,242,0.5)', marginBottom: '4px', fontWeight: '600' }}>POSITION</div>
              {isFloor ? (
                <input className="input" value="Any" readOnly style={{ width: '100%', cursor: 'default' }} />
              ) : (
                <select
                  className="input"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  disabled={disabled || !aisle}
                  style={{ width: '100%' }}
                >
                  <option value="">Select...</option>
                  {Array.from({ length: maxPositions }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Preview */}
          {value && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: 'rgba(34,197,94,0.08)',
              borderRadius: '6px',
              border: '1px solid rgba(34,197,94,0.2)'
            }}>
              <span style={{ fontSize: '12px', color: '#10b981', fontWeight: '600' }}>
                {value}
              </span>
              <button
                type="button"
                onClick={handleClear}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              >×</button>
            </div>
          )}
        </div>
      ) : (
        <input
          type="text"
          className="input"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Aisle: 1, Bay: A, Position: 3"
          disabled={disabled}
        />
      )}
    </div>
  );
}
