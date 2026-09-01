import React from 'react';
import SygenopApp from './EduLink Pro V1.jsx';

export default function ConnectPage({ onBack }) {
  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 18, left: 18, zIndex: 70 }}>
        <button
          type="button"
          onClick={onBack}
          style={{ border: '2px solid #0a4f3a', background: 'rgba(255,255,255,.9)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: '.85rem', color: '#0a4f3a', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 10, boxShadow: '0 6px 16px -6px rgba(10,79,58,.3)', backdropFilter: 'blur(6px)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          Retour à l&apos;accueil
        </button>
      </div>
      <SygenopApp />
    </div>
  );
}
