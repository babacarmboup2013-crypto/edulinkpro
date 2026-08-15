import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import SygenopApp from './EduLink Pro V1.jsx';

// Enregistrement du Service Worker (PWA) — rend l'application chargeable
// et utilisable hors-ligne après une première visite.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SygenopApp />
  </React.StrictMode>
);

