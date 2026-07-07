import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, KeyRound, Trash2, Copy, Check } from 'lucide-react';

const ROLES = ['root', 'admin', 'user', 'technician'];
const ALL_MODULES = ['SA', 'SM', 'MUSE'];
const MODULE_LABELS = { SA: 'Scent Stock Manager', SM: 'Scented Merchandise', MUSE: 'MUSE' };

// Platform-level User Management (root only) — FR-USER-1..4.
// Global role + per-module access checkboxes (D6).
export default function UserManagement({ currentUser, onBack }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [tempPwd, setTempPwd] = useState(null); // { name, password }
  const [confirmDelete, setConfirmDelete] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/platform/users');
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleModule(user, module) {
    const next = user.modules.includes(module)
      ? user.modules.filter((m) => m !== module)
      : [...user.modules, module];
    const res = await fetch(`/api/platform/users/${user.id}/modules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modules: next }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, modules: next } : u)));
    }
  }

  async function resetPassword(user) {
    const res = await fetch(`/api/platform/users/${user.id}/reset-password`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setTempPwd({ name: user.name, password: data.tempPassword });
  }

  async function deleteUser(user) {
    const res = await fetch(`/api/platform/users/${user.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setConfirmDelete(null);
      load();
    } else {
      setError(data.error || 'Failed to delete user');
      setConfirmDelete(null);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn btn-ghost" onClick={onBack}>
            <ArrowLeft size={15} style={{ verticalAlign: -3, marginRight: 4 }} /> Back
          </button>
          <h1 style={{ fontSize: 20 }}>User Management</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={15} style={{ verticalAlign: -3, marginRight: 4 }} /> Add User
        </button>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Module access</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Loading...</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.must_change_password && (
                      <span className="badge-warn" title="Must change password on next login">pwd pending</span>
                    )}
                  </td>
                  <td><span className={`badge-role role-${u.role}`}>{u.role}</span></td>
                  <td>
                    <div style={{ display: 'flex', gap: 12 }}>
                      {ALL_MODULES.map((m) => (
                        <label key={m} style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title={MODULE_LABELS[m]}>
                          <input
                            type="checkbox"
                            checked={u.modules.includes(m)}
                            onChange={() => toggleModule(u, m)}
                          />
                          {m}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost" title="Reset password" onClick={() => resetPassword(u)}>
                      <KeyRound size={14} />
                    </button>
                    {u.id !== currentUser.id && (
                      <button className="btn btn-ghost btn-danger-ghost" title="Delete user" onClick={() => setConfirmDelete(u)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={(temp) => {
            setShowCreate(false);
            setTempPwd(temp);
            load();
          }}
        />
      )}

      {tempPwd && <TempPasswordModal info={tempPwd} onClose={() => setTempPwd(null)} />}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)}>
          <h3 style={{ fontSize: 16, marginBottom: 10 }}>Delete user</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18 }}>
            Delete <strong>{confirmDelete.name}</strong>? Their history is preserved; the account is removed.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => deleteUser(confirmDelete)}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [modules, setModules] = useState(['SA']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function toggle(m) {
    setModules((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/platform/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role, modules }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onCreated({ name: data.user.name, password: data.tempPassword });
      else setError(data.error || 'Failed to create user');
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontSize: 16, marginBottom: 16 }}>Add User</h3>
      <form onSubmit={submit}>
        <div className="form-group">
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="form-group">
          <label>Role</label>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Module access</label>
          <div style={{ display: 'flex', gap: 16, paddingTop: 6 }}>
            {ALL_MODULES.map((m) => (
              <label key={m} style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={modules.includes(m)} onChange={() => toggle(m)} />
                {MODULE_LABELS[m]}
              </label>
            ))}
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={loading}>{loading ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

// SA pattern preserved: centered modal, monospace password, copy + confirm.
function TempPasswordModal({ info, onClose }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(info.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Modal onClose={() => {}}>
      <h3 style={{ fontSize: 16, marginBottom: 10 }}>Temporary password for {info.name}</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Share it securely — the user must change it on first login.
      </p>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 20,
          textAlign: 'center',
          padding: '14px 10px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid var(--border)',
          letterSpacing: '0.06em',
          marginBottom: 14,
        }}
      >
        {info.password}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={copy}>
          {copied ? <Check size={14} style={{ verticalAlign: -3, marginRight: 4 }} /> : <Copy size={14} style={{ verticalAlign: -3, marginRight: 4 }} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn btn-primary" onClick={onClose}>I've noted this password</button>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
