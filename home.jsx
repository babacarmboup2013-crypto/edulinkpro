import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import AppWithHome from './AppWithHome.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppWithHome />
  </React.StrictMode>
);