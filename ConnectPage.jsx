import React from 'react';
import SygenopApp from './EduLink Pro V1.jsx';

export default function ConnectPage({ onBack }) {
  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <SygenopApp onBack={onBack} connectHome />
    </div>
  );
}
