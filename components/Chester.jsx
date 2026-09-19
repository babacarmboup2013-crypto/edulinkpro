import React, { useState } from 'react';

/* ============================================================
   SYGENOP — Chester Widget (assistant contextuel)
   ------------------------------------------------------------
   Petit widget flottant, non intrusif. Aide contextuelle selon la
   session (écran de connexion, école ouverte, enseignant…).
   ============================================================ */
export default function ChesterWidget({ dark, session, landing }) {
  const [open, setOpen] = useState(false);

  const tip = !session
    ? landing
      ? 'Bienvenue sur EduLink Pro, la plateforme intelligente de gestion scolaire. Parcourez les modules, la version 1 et nos coordonnées, puis connectez-vous pour accéder à votre espace école.'
      : 'Bienvenue sur EduLink Pro. Sélectionnez votre école et saisissez votre code d’accès, ou utilisez un des onglets Enseignant / Groupe scolaire / Super Admin.'
    : session.role === 'teacher'
      ? 'Vous êtes connecté(e) en tant qu’enseignant(e). Vous pouvez saisir les notes de votre classe dans « Évaluation → Saisie des notes ».'
      : session.role === 'ief'
        ? 'Vous consultez votre groupe scolaire en lecture seule : tous les cycles de l’école (petite enfance, élémentaire, moyen, secondaire), sans rien modifier.'
        : session.role === 'admin'
          ? 'Super Administrateur : gérez les écoles, les groupes scolaires et les codes d’accès depuis « Gestion des écoles ».'
          : 'Connecté en tant qu’école (direction). Retrouvez le tableau de bord, le personnel, la saisie des notes, les paiements et les données.';

  return (
    <div className="fixed bottom-5 right-5 z-50" style={{ fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      {open && (
        <div
          className="sygenop-fade"
          style={{
            background: dark ? '#16211b' : '#ffffff',
            border: dark ? '1px solid #22312a' : '1px solid #e3e9e5',
            borderRadius: 16,
            boxShadow: dark
              ? '0 12px 30px -8px rgba(0,0,0,.5)'
              : '0 1px 2px rgba(10,30,20,.04),0 12px 30px -8px rgba(10,30,20,.10)',
            padding: '14px 16px',
            maxWidth: 280,
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <a
            href="https://wa.me/221774170128"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              textDecoration: 'none',
              fontSize: 11,
              fontWeight: 700,
              color: '#128c4a',
              marginBottom: 7,
              paddingBottom: 7,
              borderBottom: dark ? '1px solid #22312a' : '1px solid #eef1ef',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#16a374" aria-hidden="true">
              <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.78 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m5.83 14.12c-.25.7-1.45 1.33-2 1.38-.53.05-1.03.24-3.46-.72-2.92-1.15-4.77-4.13-4.92-4.32-.14-.2-1.17-1.56-1.17-2.97 0-1.41.74-2.1 1-2.39.26-.28.57-.35.76-.35.19 0 .38 0 .54.01.18.01.41-.07.64.49.24.57.8 1.97.87 2.11.07.14.12.31.02.5-.1.19-.14.31-.29.48-.14.17-.3.38-.43.5-.14.14-.29.3-.12.58.17.28.74 1.22 1.59 1.97 1.09.97 2 1.27 2.29 1.42.29.14.45.12.62-.07.17-.2.72-.84.91-1.13.19-.29.38-.24.64-.14.26.09 1.66.78 1.95.93.28.14.47.21.54.33.07.11.07.66-.18 1.29z" />
            </svg>
            +221 77 417 01 28
          </a>
          <div style={{ color: dark ? '#e7efe9' : '#12241a', fontWeight: 700, marginBottom: 4 }}>
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#16a374',
                marginRight: 7,
              }}
            />
            Chester — Assistant EduLink Pro
          </div>
          <p style={{ color: dark ? '#8ba396' : '#6b7670', margin: 0 }}>{tip}</p>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Aide EduLink Pro"
        className="w-11 h-11 rounded-full flex items-center justify-center text-white"
        style={{
          width: 46,
          height: 46,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          background: 'linear-gradient(135deg,#16a374,#0a4f3a)',
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 10px 24px -8px rgba(10,79,58,.55)',
          transition: 'transform .18s ease, box-shadow .25s ease',
        }}
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