import { useState } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import Login from './Login.jsx';
import ChangePassword from './ChangePassword.jsx';
import ModulePicker from './ModulePicker.jsx';
import UserManagement from './UserManagement.jsx';
import SAModule from '../sa/SAModule.jsx';
import {
  getStoredUser,
  storeSession,
  clearSession,
  setActiveModule,
} from './api.js';

// Shell flow (PRD Appendix B): Login → forced password change → Module Picker
// → module routes (/sa/*, /sm/*). URL-driven via wouter; module guards per B5.
export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [, navigate] = useLocation();

  function handleLogin(token, userData) {
    storeSession(token, userData);
    setUser(userData);
    setActiveModule(null);
    navigate('/'); // B1/B2 — always land on the picker
  }

  function handlePasswordChanged(token, userData) {
    storeSession(token, userData);
    setUser(userData);
    navigate('/');
  }

  function handleLogout() {
    clearSession();
    setUser(null);
    navigate('/');
  }

  function handlePick(moduleKey) {
    setActiveModule(moduleKey); // B3 — persist active module
    navigate(moduleKey === 'SA' ? '/sa' : '/sm');
  }

  function backToPicker() {
    setActiveModule(null);
    navigate('/');
  }

  if (!user) return <Login onLogin={handleLogin} />;

  if (user.must_change_password) {
    return <ChangePassword user={user} onChanged={handlePasswordChanged} onLogout={handleLogout} />;
  }

  const hasModule = (m) => (user.modules || []).includes(m);

  return (
    <Switch>
      <Route path="/users">
        {user.role === 'root'
          ? <UserManagement currentUser={user} onBack={backToPicker} />
          : <RedirectToPicker onDone={backToPicker} />}
      </Route>

      {/* No `nest` here — SAModule's own <Router base="/sa"> is the single
          prefixer. nest + base together double-prefixed links to /sa/sa/... */}
      <Route path="/sa/*?">
        {hasModule('SA')
          ? <SAWrapper user={user} onSwitchModule={backToPicker} onLogout={handleLogout} />
          : <RedirectToPicker onDone={backToPicker} />}
      </Route>

      <Route path="/sm/*?">
        {hasModule('SM')
          ? <SMPlaceholder onBack={backToPicker} onLogout={handleLogout} />
          : <RedirectToPicker onDone={backToPicker} />}
      </Route>

      <Route>
        <ModulePicker
          user={user}
          onPick={handlePick}
          onLogout={handleLogout}
          onOpenUsers={() => navigate('/users')}
        />
      </Route>
    </Switch>
  );
}

function SAWrapper({ user, onSwitchModule, onLogout }) {
  // Ensure the interceptor prefixes /api → /api/sa for SA pages even after
  // a full page reload directly on an /sa/* URL.
  setActiveModule('SA');
  return <SAModule user={user} onSwitchModule={onSwitchModule} onLogout={onLogout} />;
}

// B5 — no access → back to picker
function RedirectToPicker({ onDone }) {
  onDone();
  return null;
}

// Replaced by the real SM module UI in Phase 3c.
function SMPlaceholder({ onBack, onLogout }) {
  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 14 }}>
      <h1 style={{ fontSize: 22 }}>Scented Merchandise</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        Module UI arrives in Phase 3. Access guard verified — you are inside the SM module.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-ghost" onClick={onBack}>Switch module</button>
        <button className="btn btn-ghost btn-danger-ghost" onClick={onLogout}>Logout</button>
      </div>
    </div>
  );
}
