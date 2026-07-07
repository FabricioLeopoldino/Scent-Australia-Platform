import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './shell/App.jsx';
import { installFetchInterceptor } from './shell/api.js';
import './index.css';

installFetchInterceptor();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
