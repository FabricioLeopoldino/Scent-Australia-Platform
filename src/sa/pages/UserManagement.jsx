import { useState, useEffect } from 'react';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { GlowingEffect } from '../components/GlowingEffect';

const ROLE_BADGE = {
  root:  { bg: 'rgba(251,191,36,0.15)',  color: '#fbbf24', border: 'rgba(251,191,36,0.4)'  },
  admin: { bg: 'rgba(99,102,241,0.15)',  color: '#818cf8', border: 'rgba(99,102,241,0.4)'  },
  user:  { bg: 'rgba(100,116,139,0.15)', color: '#94a3b8', border: 'rgba(100,116,139,0.4)' },
};

function TempPasswordModal({ userName, password, onClose }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h2>Temporary Password</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
          User: <strong style={{ color: 'var(--text-primary)' }}>{userName}</strong>
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          Share this password with the user. They will be required to change it on first login.
        </p>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)',
          borderRadius: 10, padding: '14px 16px', marginBottom: 24,
        }}>
          <span style={{
            flex: 1, fontFamily: 'monospace', fontSize: 20, fontWeight: 700,
            color: '#fbbf24', letterSpacing: 2, userSelect: 'all'
          }}>
            {password}
          </span>
          <button
            onClick={handleCopy}
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '5px 12px', whiteSpace: 'nowrap' }}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>
          I've noted this password
        </button>
      </div>
    </div>
  );
}

export default function UserManagement({ user: currentUser }) {
  const showToast = useToast();
  const [confirmState, setConfirmState] = useState(null);
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', role: 'user' });
  const [submitting, setSubmitting] = useState(false);
  const [tempPwd, setTempPwd] = useState(null); // { userName, password }

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast('Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        const data = await res.json();
        setShowModal(false);
        setFormData({ name: '', role: 'user' });
        fetchUsers();
        setTempPwd({ userName: data.name, password: data.tempPassword });
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to create user', 'error');
      }
    } catch { showToast('Failed to create user', 'error'); }
    finally { setSubmitting(false); }
  };

  const handleDelete = (targetUser) => {
    setConfirmState({
      message: `Delete user "${targetUser.name}"? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/users/${targetUser.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requesterId: currentUser.id })
          });
          if (res.ok) {
            showToast(`User "${targetUser.name}" deleted`, 'success');
            fetchUsers();
          } else {
            const err = await res.json();
            showToast(err.error || 'Failed to delete user', 'error');
          }
        } catch { showToast('Failed to delete user', 'error'); }
      }
    });
  };

  const handleResetPassword = (targetUser) => {
    setConfirmState({
      message: `Reset password for "${targetUser.name}"? A new random temporary password will be generated. They will be required to change it on next login.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/users/${targetUser.id}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requesterId: currentUser.id })
          });
          if (res.ok) {
            const data = await res.json();
            fetchUsers();
            setTempPwd({ userName: targetUser.name, password: data.tempPassword });
          } else {
            const err = await res.json();
            showToast(err.error || 'Failed to reset password', 'error');
          }
        } catch { showToast('Failed to reset password', 'error'); }
      }
    });
  };

  if (loading) return <div className="container">Loading...</div>;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>User Management</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Root only — manage system access
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          + New User
        </button>
      </div>

      <div className="card" style={{ position: 'relative', overflow: 'visible' }}>
        <GlowingEffect spread={30} glow={false} disabled={false} proximity={80} inactiveZone={0.1} borderWidth={1.5} />
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const badge = ROLE_BADGE[u.role] || ROLE_BADGE.user;
              const isSelf = u.id === currentUser.id;
              return (
                <tr key={u.id}>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.id}</td>
                  <td>
                    <strong>{u.name}</strong>
                    {isSelf && <span style={{ marginLeft: 6, fontSize: 11, color: '#60a5fa' }}>(you)</span>}
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                      fontSize: 11, fontWeight: 700,
                      background: badge.bg, color: badge.color,
                      border: `1px solid ${badge.border}`,
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    {u.must_change_password ? (
                      <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                        fontSize: 11, fontWeight: 700,
                        background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
                        border: '1px solid rgba(251,191,36,0.35)',
                      }}>
                        Must change pwd
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Active</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {u.created_at ? new Date(u.created_at).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {!isSelf && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => handleResetPassword(u)}
                        >
                          Reset Pwd
                        </button>
                      )}
                      {!isSelf && u.role !== 'root' && (
                        <button
                          className="btn btn-danger"
                          style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => handleDelete(u)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New User</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Username *</label>
                <input
                  type="text" className="input"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  required placeholder="Enter username"
                />
              </div>
              <div className="form-group">
                <label>Role *</label>
                <select className="input" value={formData.role}
                  onChange={e => setFormData({ ...formData, role: e.target.value })}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                  <option value="root">Root</option>
                </select>
              </div>
              <div style={{
                padding: '12px 14px', borderRadius: 8, marginBottom: 20,
                background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
                fontSize: 13, color: 'var(--text-muted)'
              }}>
                A random temporary password will be generated and shown after creation.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Creating...' : 'Create User'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Temp Password Modal */}
      {tempPwd && (
        <TempPasswordModal
          userName={tempPwd.userName}
          password={tempPwd.password}
          onClose={() => setTempPwd(null)}
        />
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
