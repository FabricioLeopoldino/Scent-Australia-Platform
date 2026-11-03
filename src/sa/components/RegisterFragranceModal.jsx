import { useEffect, useState } from 'react';
import { MUSE_UNITS, sectorLabel } from '../../../shared/sectors.js';

// Register an oil in a company, or edit its registration (PRD_STAGE_1_FRAGRANCE_LIBRARY.md
// S6, D3). One oil record, never a copy: this only says the company holds it.
// SA keeps its bin on the oil itself (Edit); a MUSE registration has its own
// bin, its commercial name and the MUSE units that use the oil. Admin and root
// only — the server checks it as well.
//
// Opened from the All stock row, and from the receive and transfer windows
// when the server refused oil into a company where it is not registered. It
// is always rendered as a SIBLING of those windows, never inside one: a
// .modal has backdrop-filter, which would trap this fixed overlay in its box.
//
// Always starts from the oil's CURRENT registrations — loaded here when the
// caller does not have them (the purchase orders page) — and sends only what
// the person changed, so an existing bin, commercial name or "used by" is never
// overwritten with this window's defaults (fix round 1, S4). Opened from a
// refusal (`fromRefusal`), Active starts ticked: registering is the point, and
// saving it unticked would only bring the same refusal back (S3).
export default function RegisterFragranceModal({ product, company: initialCompany = 'SA', fromRefusal = false, onClose, onDone, showToast }) {
  const [regs, setRegs] = useState(product.registrations || null);
  const formFor = (c, rs = regs) => {
    const r = rs?.[c];
    return {
      active: fromRefusal || (r ? r.active !== false : true),
      commercialName: r?.commercialName || product.name || '',
      binLocation: r?.binLocation || '',
      // Nothing ticked on a new registration: a pre-ticked Library was kept by
      // whoever registered for The Archive and forgot to untick it (QA, 29 Oct).
      // Saving still needs at least one unit.
      usedBy: r?.usedBy?.length ? r.usedBy : [],
    };
  };
  const [company, setCompany] = useState(initialCompany);
  const [form, setForm] = useState(() => formFor(initialCompany));
  const [busy, setBusy] = useState(false);
  const existing = regs?.[company];

  // A failed read says so in the window, with Retry; Cancel always works, and
  // the company switch waits for the read (fix round 2, R5).
  const [loadError, setLoadError] = useState(null);
  const load = () => {
    setLoadError(null);
    fetch(`/api/fragrance-registrations?productId=${encodeURIComponent(product.id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rows) => {
        // The GET list's rows → the { SA?, MUSE? } shape GET /products carries.
        const loaded = {};
        for (const r of rows) if (r.productId === product.id) loaded[r.company] = r;
        setRegs(loaded);
      })
      .catch((err) => setLoadError(err.message));
  };
  useEffect(() => { if (!regs) load(); }, []);
  // When they arrive, the form starts from the company shown at that moment.
  useEffect(() => { if (regs && !product.registrations) setForm(formFor(company, regs)); }, [regs]);

  const pick = (c) => { setCompany(c); setForm(formFor(c)); };
  const toggleUnit = (k) => setForm((f) => ({
    ...f, usedBy: f.usedBy.includes(k) ? f.usedBy.filter((u) => u !== k) : [...f.usedBy, k],
  }));

  const submit = async (e) => {
    e.preventDefault();
    if (!regs) return;
    if (company === 'MUSE' && !form.usedBy.length) return showToast('Tick at least one MUSE unit that uses it', 'warning');
    // A new registration sends what is on the form; an existing one only what changed.
    const start = existing ? formFor(company) : {};
    const changed = (k) => JSON.stringify(form[k]) !== JSON.stringify(start[k]);
    const fields = (company === 'MUSE' ? ['active', 'commercialName', 'binLocation', 'usedBy'] : ['active'])
      .filter((k) => !existing || changed(k) || (k === 'active' && form.active !== (existing.active !== false)));
    setBusy(true);
    try {
      const res = await fetch('/api/fragrance-registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, company, ...Object.fromEntries(fields.map((k) => [k, form[k]])) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showToast(data.error || 'Could not register the fragrance', 'error');
      // null = saved, but the server could not read it back (F1): what was sent is what was saved.
      const saved = data.registrations === null ? { active: form.active } : data.registrations?.[company];
      showToast(saved?.active
        ? `${product.name} ${existing ? 'updated' : 'registered'} in ${company}`
        : `${product.name} saved — not active in ${company}, so oil cannot go into ${company} yet`,
      saved?.active ? 'success' : 'warning');
      onDone(data.registrations || {}, !!saved?.active);
    } catch (err) {
      showToast('Could not register the fragrance: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Register {product.name}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {['SA', 'MUSE'].map((c) => (
              <button key={c} type="button" onClick={() => pick(c)} disabled={!regs}
                className={company === c ? 'btn btn-primary' : 'btn btn-secondary'} style={{ padding: '6px 14px' }}>
                {c}{regs?.[c] ? (regs[c].active === false ? ' (inactive)' : ' ✓') : ''}
              </button>
            ))}
          </div>
          {loadError && (
            <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 12.5, color: '#f87171',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span>Could not read this oil's registrations ({loadError}).</span>
              <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={load}>Retry</button>
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
            {!regs ? (loadError ? 'Nothing can be saved until they are read.' : 'Reading its registrations…') : existing
              ? `Already registered in ${company} — saving changes the registration.`
              : `Not registered in ${company} yet. Once registered, oil can be received, transferred and counted into ${company}'s stocks.`}
          </div>

          {company === 'MUSE' && (
            <>
              <div className="form-group">
                <label>Commercial name</label>
                <input className="input" value={form.commercialName}
                  onChange={(e) => setForm({ ...form, commercialName: e.target.value })} />
              </div>
              {/* Plain text: MUSE's shelves are not SA's Aisle/Bay layout. */}
              <div className="form-group">
                <label>Bin location (MUSE)</label>
                <input className="input" value={form.binLocation} placeholder="e.g. Shelf B3"
                  onChange={(e) => setForm({ ...form, binLocation: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Used by *</label>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {MUSE_UNITS.map((k) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 400, margin: 0, cursor: 'pointer' }}>
                      <input type="checkbox" checked={form.usedBy.includes(k)} onChange={() => toggleUnit(k)} />
                      {sectorLabel(k).replace(/^MUSE /, '')}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {company === 'SA' && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
              SA's bin location stays on the oil — change it with Edit.
            </div>
          )}

          {(existing || company === 'SA') && (
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active in {company}
              </label>
            </div>
          )}

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !regs}>
              {busy ? 'Saving…' : existing ? 'Save' : `Register in ${company}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
