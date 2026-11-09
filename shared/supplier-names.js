// Supplier names (owner, 9 Nov 2026): ONE registry, sa.suppliers. A product
// picks from it; only admin/root register a new name, and the registry refuses
// a name that is the same as, or very close to, one already there — the
// "Luxorama" that started the mess.

// Case, spaces and punctuation do not make a different supplier.
export const supplierKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// The registered supplier with the same key, or null.
export const sameSupplier = (name, suppliers) =>
  suppliers.find((s) => supplierKey(s.name) === supplierKey(name)) || null;

// A registered supplier that looks like a typo of `name` (up to two letters
// off, or one name inside the other), or null. Short keys only match exactly:
// "FIA" and "IFF" are two real suppliers.
export function similarSupplier(name, suppliers) {
  const k = supplierKey(name);
  if (k.length < 4) return null;
  return suppliers.find((s) => {
    const sk = supplierKey(s.name);
    if (sk.length < 4 || sk === k) return false;
    return editDistance(k, sk) <= 2 || sk.includes(k) || k.includes(sk);
  }) || null;
}
