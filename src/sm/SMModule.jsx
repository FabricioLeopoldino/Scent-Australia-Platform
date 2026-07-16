import { useState, createContext, useContext } from 'react';
import { Router, Route, Switch } from 'wouter';
import axios from 'axios';
import { Check, AlertTriangle, X } from 'lucide-react';
import { getToken, clearSession } from '../shell/api.js';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import StockManagement from './pages/StockManagement.jsx';
import Clients from './pages/Clients.jsx';
import ProductionOrders from './pages/ProductionOrders.jsx';
import ManufacturingQueue from './pages/ManufacturingQueue.jsx';
import TransactionHistory from './pages/TransactionHistory.jsx';
import IncomingOrders from './pages/IncomingOrders.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Returns from './pages/Returns.jsx';
import BarcodeScanner from './pages/BarcodeScanner.jsx';
import PackingRecords from './pages/PackingRecords.jsx';
import Suppliers from './pages/Suppliers.jsx';
import MuseStock from './pages/MuseStock.jsx';
import MuseProducts from './pages/MuseProducts.jsx';
import MuseDashboard from './pages/MuseDashboard.jsx';
import StandardCatalog from './pages/StandardCatalog.jsx';
import ContainerTypes from './pages/ContainerTypes.jsx';
import MajorClients from './pages/MajorClients.jsx';
import MajorClientDetail from './pages/MajorClientDetail.jsx';
import BOMScentedMerchandise from './pages/BOMScentedMerchandise.jsx';
import StockScentedMerchandise from './pages/StockScentedMerchandise.jsx';
import BOMMuse from './pages/BOMMuse.jsx';
import ExternalProcessing from './pages/ExternalProcessing.jsx';
import './sm.css';

// ─────────────────────────────────────────
// Contexts — same exports the original SM App.jsx provided; the 30+ page
// imports were rewritten from '../App.jsx' to '../SMModule.jsx' verbatim.
// ─────────────────────────────────────────
export const AuthContext = createContext(null);
export function useAuth() {
  return useContext(AuthContext);
}

export const ToastContext = createContext(null);
export function useToast() {
  return useContext(ToastContext);
}

// ─────────────────────────────────────────
// Axios interceptors — SM pages call axios('/api/...') which bypasses the
// window.fetch interceptor. Installed once at module scope:
//   request:  /api/* → /api/sm/* (platform/sa/sm/webhook/health untouched)
//             + Authorization from the platform session
//   response: 401 → clear session, back to login (matches shell behavior)
// ─────────────────────────────────────────
const NON_MODULE = ['/api/platform', '/api/sa', '/api/sm', '/api/webhook', '/api/health'];
let axiosPatched = false;
function installAxiosInterceptors() {
  if (axiosPatched) return;
  axiosPatched = true;
  axios.interceptors.request.use((config) => {
    let url = config.url || '';
    if (url.startsWith('/api/') && !NON_MODULE.some((p) => url === p || url.startsWith(p + '/'))) {
      config.url = '/api/sm' + url.slice('/api'.length);
    }
    const token = getToken();
    if (token && (config.url || '').startsWith('/api/')) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
  axios.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response?.status === 401 && (err.config?.url || '').startsWith('/api/')) {
        clearSession();
        window.location.href = '/';
      }
      return Promise.reject(err);
    }
  );
}
installAxiosInterceptors();

// ─────────────────────────────────────────
// SM MODULE (Scented Merchandise + MUSE views) — Phase 3c
// Login/forced-password-change/user-management live in the platform shell.
// ─────────────────────────────────────────
export default function SMModule({ user, onLogout }) {
  const [toasts, setToasts] = useState([]);

  function addToast(message, type = 'success', duration = 4000) {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), duration);
  }

  return (
    <AuthContext.Provider value={{ user, login: () => {}, logout: onLogout }}>
      <ToastContext.Provider value={{ addToast }}>
        <div className="sm-scope">
          {/* Toast container (visuals identical to the original SM App) */}
          <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column-reverse', gap: 8 }}>
            {toasts.map((t) => (
              <div key={t.id} style={{
                background:
                  t.type === 'error' ? 'rgba(20,4,4,0.95)' :
                  t.type === 'warning' ? 'rgba(20,14,4,0.95)' :
                  'rgba(4,18,10,0.95)',
                border: `1px solid ${t.type === 'error' ? 'rgba(220,38,38,0.4)' : t.type === 'warning' ? 'rgba(245,158,11,0.4)' : 'rgba(34,197,94,0.4)'}`,
                color: t.type === 'error' ? '#f87171' : t.type === 'warning' ? '#fbbf24' : '#4ade80',
                padding: '11px 16px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                boxShadow: `0 6px 24px rgba(0,0,0,0.6)`,
                backdropFilter: 'blur(12px)', maxWidth: 320,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  {t.type === 'error' ? <X size={15} /> : t.type === 'warning' ? <AlertTriangle size={15} /> : <Check size={15} />}
                </span>
                {t.message}
              </div>
            ))}
          </div>

          <Router base="/sm">
            <Layout>
              <Switch>
                <Route path="/" component={Dashboard} />
                <Route path="/production-orders" component={ProductionOrders} />
                <Route path="/manufacturing-queue" component={ManufacturingQueue} />
                <Route path="/products" component={StockManagement} />
                <Route path="/stock" component={StockManagement} />
                <Route path="/customers" component={Clients} />
                <Route path="/barcode" component={BarcodeScanner} />
                <Route path="/incoming-orders" component={IncomingOrders} />
                <Route path="/external-processing" component={ExternalProcessing} />
                <Route path="/returns" component={Returns} />
                <Route path="/transactions" component={TransactionHistory} />
                <Route path="/activity-log" component={ActivityLog} />
                <Route path="/packing-records" component={PackingRecords} />
                <Route path="/suppliers" component={Suppliers} />
                <Route path="/muse-stock" component={MuseStock} />
                <Route path="/muse" component={MuseDashboard} />
                <Route path="/muse/products" component={MuseProducts} />
                <Route path="/container-types" component={ContainerTypes} />
                <Route path="/fragrances" component={StockManagement} />
                <Route path="/standard/catalog" component={StandardCatalog} />
                <Route path="/major-clients" component={MajorClients} />
                <Route path="/major-clients/:id" component={MajorClientDetail} />
                <Route path="/bom-sm" component={BOMScentedMerchandise} />
                <Route path="/sm-stock" component={StockScentedMerchandise} />
                <Route path="/bom-muse" component={BOMMuse} />
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </Router>
        </div>
      </ToastContext.Provider>
    </AuthContext.Provider>
  );
}

function NotFound() {
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontFamily: 'Archivo Black, sans-serif', fontSize: 24, color: 'var(--text-primary)', marginBottom: 12 }}>Page Not Found</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>This page does not exist in the SM module.</p>
    </div>
  );
}
