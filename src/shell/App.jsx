import { useState } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import Login from './Login.jsx';
import ChangePassword from './ChangePassword.jsx';
import ModulePicker from './ModulePicker.jsx';
import UserManagement from './UserManagement.jsx';
import SAModule from '../sa/SAModule.jsx';
import SMModule from '../sm/SMModule.jsx';
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
          ? <SMWrapper user={user} onLogout={handleLogout} />
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

function SMWrapper({ user, onLogout }) {
  setActiveModule('SM'); // keep interceptors module-aware after deep reloads
  return <SMModule user={user} onLogout={onLogout} />;
}

// B5 — no access → back to picker
function RedirectToPicker({ onDone }) {
  onDone();
  return null;
}
