import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import SygenopApp from './EduLink Pro V1.jsx';

// Page /admin : écran de connexion réservé au Super Admin, séparé de l'écran
// public (école / personnel / groupe scolaire).
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SygenopApp adminOnly />
  </React.StrictMode>
);
