import { useState } from 'react';
import { SECTORS } from '../../../shared/sectors.js';
import { displayStock, displayUnit } from '../utils/unitConversion';
import RegisterFragranceModal from './RegisterFragranceModal';

// Receive a fragrance purchase order and split it between the stocks
// (PRD_STAGE_1_FRAGRANCE_LIBRARY.md §2.3, S7–S8): one line per destination —
// the main store, SA and the four MUSE stocks. The lines must add up to what
// arrived (a typing error is refused, here and by the server, in the same
// words); a part receipt is allowed — type less than is left on the order.
// It opens with the whole delivery on SA's line, so one click receives it as
// before Stage 1. Oil only: every other product keeps the old window.
export default function ReceiveSplitModal({ poId, orderNumber, remaining, product, user, onClose, onDone, onRegistered, showToast }) {
  const isMl = product.unit === 'mL';
  const unitWord = displayUnit(product.unit);
  const toUnit = (v) => (isMl ? Math.round(parseFloat(v) * 1000 * 1000) / 1000 : parseFloat(v));
  const fromUnit = (v) => (isMl ? v / 1000 : v);
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const startQty = String(round3(fromUnit(Math.max(0, remaining))));

  const [arrived, setArrived] = useState(startQty);
  const [lines, setLines] = useState({ SA: startQty });
  // Until a line is typed in, SA's line follows "Arrived" (a part receipt
  // still goes to SA in one click).
  const [linesTouched, setLinesTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null); // { error, code, company, productId }
  const [registerFor, setRegisterFor] = useState(null); // { company, productId }
  // Unknown (the purchase orders page) stays undefined: the Register window then reads them itself (S4).
  const [registrations, setRegistrations] = useState(product.registrations);

  const arrivedQty = parseFloat(arrived) || 0;
  const linesTotal = round3(Object.values(lines).reduce((s, v) => s + (parseFloat(v) || 0), 0));
  const mismatch = Math.abs(linesTotal - arrivedQty) > 0.0005;
  const overOrder = toUnit(arrivedQty || 0) > remaining + 0.001;

  const changeArrived = (v) => {
    setArrived(v);
    if (!linesTouched) setLines({ SA: v });
  };
  const changeLine = (key, v) => {
    setLinesTouched(true);
    setLines((l) => ({ ...l, [key]: v }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!(arrivedQty > 0)) return showToast('Enter how much arrived', 'warning');
    if (mismatch) return;
    setBusy(true);
    setRefused(null);
    const qty = toUnit(arrivedQty);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantityReceived: qty,
          lines: SECTORS.filter((s) => parseFloat(lines[s.key]) > 0).map((s) => ({ to: s.key, quantity: toUnit(lines[s.key]) })),
          notes: notes || (qty >= remaining - 0.001 ? 'Full quantity received' : `Partial quantity received: ${qty} of ${remaining}`),
          receivedBy: user?.username || user?.name || 'admin',
          userId: user?.id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Kept on screen, not only toasted: a NOT_REGISTERED refusal carries the
        // Register now button, and the person has to read which company.
        setRefused({ error: data.error || 'Could not receive the order', code: data.code, company: data.company, productId: data.productId });
        return;
      }
      showToast(`${orderNumber} received — ${displayStock(qty, product.unit)} of ${product.name}`, 'success');
      onDone(data);
    } catch (err) {
      showToast('Could not receive the order: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Receive {orderNumber} — {product.name}</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          <form onSubmit={submit}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Still to arrive on this order: <strong style={{ color: 'var(--text-primary)' }}>{displayStock(remaining, product.unit)}</strong>
            </div>

            <div className="form-group">
              <label>Arrived ({unitWord}) *</label>
              <input className="input" type="number" min="0" step="any" value={arrived}
                onChange={(e) => changeArrived(e.target.value)} required />
              {overOrder && (
                <small style={{ color: '#fbbf24', display: 'block', marginTop: 4 }}>
                  More than is left on the order — it will be refused.
                </small>
              )}
            </div>

            <div className="form-group">
              <label>Where it goes ({unitWord})</label>
              {/* Two columns: six lines stacked pushed Confirm below the fold at 1366×768. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 14px' }}>
                {SECTORS.map((s) => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 112, fontSize: 12.5, flexShrink: 0 }}>{s.label}</span>
                    <input className="input" type="number" min="0" step="any" placeholder="0"
                      value={lines[s.key] || ''} onChange={(e) => changeLine(s.key, e.target.value)} />
                  </div>
                ))}
              </div>
              <small style={{ display: 'block', marginTop: 4, color: mismatch ? '#f87171' : 'var(--text-secondary)', fontWeight: mismatch ? 700 : 400 }}>
                {mismatch
                  ? `The lines add up to ${linesTotal} ${unitWord}; ${round3(arrivedQty)} ${unitWord} arrived.`
                  : `Lines: ${linesTotal} ${unitWord} of ${round3(arrivedQty)} ${unitWord} arrived.`}
              </small>
            </div>

            <div className="form-group">
              <label>Notes (optional)</label>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Received in good condition" />
            </div>

            {refused && (
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>{refused.error}</span>
                {refused.code === 'NOT_REGISTERED' && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => setRegisterFor({ company: refused.company || 'SA', productId: refused.productId || product.id })}>
                    Register now
                  </button>
                )}
              </div>
            )}

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || mismatch}
                style={{ background: '#10b981', borderColor: '#10b981' }}>
                {busy ? 'Saving…' : 'Confirm & Update Stock'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* A sibling, not a child: inside the .modal above it would be trapped in its box. */}
      {registerFor && (
        <RegisterFragranceModal
          product={{ ...product, id: registerFor.productId, registrations }}
          company={registerFor.company}
          fromRefusal
          showToast={showToast}
          onClose={() => setRegisterFor(null)}
          onDone={(regs, active) => {
            setRegistrations(regs);
            setRegisterFor(null);
            onRegistered?.(registerFor.productId, regs);
            // Only an active registration lifts the refusal (S3).
            if (active) { setRefused(null); showToast('Registered — press Confirm again', 'info'); }
          }}
        />
      )}
    </>
  );
}
