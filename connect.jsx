import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import ConnectPage from './ConnectPage.jsx';

const goHome = () => { window.location.href = `${import.meta.env.BASE_URL}home.html`; };

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConnectPage onBack={goHome} />
  </React.StrictMode>
);
