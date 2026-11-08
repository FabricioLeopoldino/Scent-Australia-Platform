import { useEffect, useState } from 'react';

// A product's supplier comes from the one registry (owner, 9 Nov 2026): pick it,
// or register a missing one here. The server refuses a name that is the same as
// or close to a registered one ("Luxorama" → "Did you mean Luxaroma?").
const hint = { fontSize: 11, color: 'var(--text-muted)', marginTop: 4 };
const NEW = '__new__';

export default function SupplierPicker({ value, onChange }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [leadTime, setLeadTime] = useState('');
  const [problem, setProblem] = useState(null); // { text, suggestion? }
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/suppliers').then((r) => r.json()).then((rows) => setList(Array.isArray(rows) ? rows : [])).catch(() => setList([]));
  }, []);

  const registered = !value || list.some((s) => s.name === value);

  const register = async (confirmNew = false) => {
    setSaving(true); setProblem(null);
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), lead_time: parseInt(leadTime), confirm_new: confirmNew }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.existing) { onChange(body.existing.name); setAdding(false); return; }
      if (!res.ok) { setProblem({ text: body.error || `Could not register (${res.status})`, suggestion: body.suggestion }); return; }
      setList((l) => [...l, body].sort((a, b) => a.name.localeCompare(b.name)));
      onChange(body.name);
      setAdding(false); setName(''); setLeadTime('');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <select className="input" value={value || ''} aria-label="Supplier"
        onChange={(e) => { if (e.target.value === NEW) { setAdding(true); setProblem(null); } else onChange(e.target.value); }}>
        <option value="">— No supplier —</option>
        {!registered && <option value={value}>{value} (not registered)</option>}
        {list.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        <option value={NEW}>+ Register a new supplier…</option>
      </select>
      {!registered && <div style={{ ...hint, color: 'var(--warning, #fbbf24)' }}>"{value}" is not in the supplier list. Pick the right one.</div>}

      {adding && (
        <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder="Supplier name" value={name} autoFocus
              onChange={(e) => { setName(e.target.value); setProblem(null); }} style={{ flex: 2 }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
            <input className="input" type="number" min={1} placeholder="Lead time (days)" value={leadTime}
              onChange={(e) => setLeadTime(e.target.value)} style={{ flex: 1 }} />
          </div>
          {problem && (
            <div style={{ ...hint, color: 'var(--warning, #fbbf24)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {problem.text}
              {problem.suggestion && <>
                <button type="button" className="btn btn-primary" onClick={() => { onChange(problem.suggestion.name); setAdding(false); }}>Use {problem.suggestion.name}</button>
                <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => register(true)}>Register "{name.trim()}" anyway</button>
              </>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-primary" disabled={saving || !name.trim() || !(parseInt(leadTime) > 0)} onClick={() => register(false)}>
              {saving ? 'Registering…' : 'Register'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => { setAdding(false); setProblem(null); }}>Cancel</button>
          </div>
          <div style={hint}>Only admins and root can register a supplier. The lead time feeds Demand Planning.</div>
        </div>
      )}
    </div>
  );
}
