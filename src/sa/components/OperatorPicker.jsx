// Who physically did the work. Deliberately NOT the login list: Gustavo and
// Wanderson have no account and work through somebody else's, so the account
// records which login was used, not who did it (owner, 18/08/2026).
//
// Shared from 31/08/2026, when manual stock adjustments needed the same question
// the returns form already asked. It lived inside ProductReturns until then; a
// second copy is how the two free-text boxes it replaced drifted apart in the
// first place.

// ONE picker, used by the manual tab and the scanner tab. They are the same
// question asked twice, and two copies is how the free-text boxes drifted into
// twelve spellings of four names in the first place.
//
// More than one person is normal, not an edge case: "Fabricio/Joao" in the
// history always meant both of them did it together, which is why this selects
// several rather than one.
export default function OperatorPicker({ operators, selected, onChange, label, fallbackValue, onFallbackChange }) {
  // No list means the lookup failed. Fall back to typing rather than blocking
  // the return — the old behaviour, kept only for that case.
  if (!operators.length) {
    return (
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label className="label">{label} *</label>
        <input type="text" className="input" value={fallbackValue}
          onChange={(e) => onFallbackChange(e.target.value)} placeholder="Your name" />
        <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 4 }}>
          The operator list could not be loaded — typing a name still works.
        </div>
      </div>
    );
  }
  const toggle = (id) => onChange(selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id]);
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      <label className="label">{label} *</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {operators.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)}
              aria-pressed={on}
              style={{
                // 44px tall: this is used on the warehouse touch screen.
                minHeight: 44, padding: '0 16px', borderRadius: 8, cursor: 'pointer',
                fontSize: 13, fontWeight: on ? 700 : 500,
                background: on ? 'rgba(16,185,129,0.18)' : 'var(--surface-2)',
                color: on ? '#10b981' : 'rgba(232,234,242,0.75)',
                border: `1px solid ${on ? 'rgba(16,185,129,0.55)' : 'var(--border)'}`,
                transition: 'background 180ms, color 180ms, border-color 180ms',
              }}>
              {on ? '✓ ' : ''}{o.name}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(232,234,242,0.4)', marginTop: 6 }}>
        Tap everyone who did the work. Someone missing? They need adding to the
        operator list — do not put the name in the notes.
      </div>
    </div>
  );
}
