import React, { useState } from 'react';

/* ============================================================
   SYGENOP — Chester Widget (assistant contextuel)
   ------------------------------------------------------------
   Petit widget flottant, non intrusif. Aide contextuelle selon la
   session (écran de connexion, école ouverte, enseignant…).
   ============================================================ */
export default function ChesterWidget({ dark, session }) {
  const [open, setOpen] = useState(false);

  const tip = !session
    ? 'Bienvenue sur EduLink Pro. Sélectionnez votre école et saisissez votre code d’accès, ou utilisez un des onglets Enseignant / IEF / Super Admin.'
    : session.role === 'teacher'
      ? 'Vous êtes connecté(e) en tant qu’enseignant(e). Vous pouvez saisir les notes de votre classe dans « Évaluation → Saisie des notes ».'
      : session.role === 'ief'
        ? 'Vous êtes en lecture seule (IEF). Vous pouvez consulter toutes les écoles sans rien modifier.'
        : session.role === 'admin'
          ? 'Super Administrateur : gérez les écoles, les comptes IEF et les codes d’accès depuis « Gestion des écoles ».'
          : 'Connecté en tant qu’école (direction). Retrouvez le tableau de bord, le personnel, la saisie des notes, les paiements et les données.';

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open && (
        <div
          className="sygenop-card p-4 max-w-xs sygenop-fade mb-2 text-xs leading-relaxed"
          style={{ background: dark ? '#16211b' : '#ffffff' }}
        >
          <div style={{ color: dark ? '#e7efe9' : '#12241a' }} className="font-bold mb-1">Chester — Assistant EduLink Pro</div>
          <p style={{ color: dark ? '#8ba396' : '#6b7670' }}>{tip}</p>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Aide EduLink Pro"
        className="w-11 h-11 rounded-full flex items-center justify-center text-white shadow-lg"
        style={{ background: 'linear-gradient(135deg,#16a374,#0a4f3a)' }}
      >
        {open ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>
    </div>
  );
}

