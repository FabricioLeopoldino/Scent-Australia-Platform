import { useState } from 'react';
import Login from './Login.jsx';
import ChangePassword from './ChangePassword.jsx';
import ModulePicker from './ModulePicker.jsx';
import UserManagement from './UserManagement.jsx';
import {
  getStoredUser,
  storeSession,
  clearSession,
  setActiveModule,
  getActiveModule,
} from './api.js';

// Shell flow (PRD Appendix B): Login → forced password change → Module Picker
// → module screens. SA/SM module UIs land in Phases 2c/3c — until then a
// placeholder confirms module entry and guard behavior.
export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [screen, setScreen] = useState(() => (getActiveModule() ? 'module' : 'picker'));

  function handleLogin(token, userData) {
    storeSession(token, userData);
    setUser(userData);
    setScreen('picker'); // B1/B2 — always land on the picker
  }

  function handlePasswordChanged(token, userData) {
    storeSession(token, userData);
    setUser(userData);
    setScreen('picker');
  }

  function handleLogout() {
    clearSession();
    setUser(null);
    setScreen('picker');
  }

  function handlePick(moduleKey) {
    setActiveModule(moduleKey); // B3 — persist active module
    setScreen('module');
  }

  function backToPicker() {
    setActiveModule(null);
    setScreen('picker');
  }

  if (!user) return <Login onLogin={handleLogin} />;

  if (user.must_change_password) {
    return <ChangePassword user={user} onChanged={handlePasswordChanged} onLogout={handleLogout} />;
  }

  if (screen === 'users' && user.role === 'root') {
    return <UserManagement currentUser={user} onBack={() => setScreen('picker')} />;
  }

  if (screen === 'module') {
    const active = getActiveModule();
    // B5 — no access → back to picker
    if (!active || !(user.modules || []).includes(active)) {
      setActiveModule(null);
      return (
        <ModulePicker
          user={user}
          onPick={handlePick}
          onLogout={handleLogout}
          onOpenUsers={() => setScreen('users')}
        />
      );
    }
    return <ModulePlaceholder moduleKey={active} onBack={backToPicker} onLogout={handleLogout} />;
  }

  return (
    <ModulePicker
      user={user}
      onPick={handlePick}
      onLogout={handleLogout}
      onOpenUsers={() => setScreen('users')}
    />
  );
}

// Replaced by the real module UIs in Phases 2c (SA) and 3c (SM).
function ModulePlaceholder({ moduleKey, onBack, onLogout }) {
  const names = { SA: 'Scent Stock Manager', SM: 'Scented Merchandise' };
  const phase = moduleKey === 'SA' ? 'Phase 2' : 'Phase 3';
  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 22 }}>{names[moduleKey] || moduleKey}</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        Module UI arrives in {phase}. Access guard verified — you are inside the {moduleKey} module.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-ghost" onClick={onBack}>Switch module</button>
        <button className="btn btn-ghost btn-danger-ghost" onClick={onLogout}>Logout</button>
      </div>
    </div>
  );
}
