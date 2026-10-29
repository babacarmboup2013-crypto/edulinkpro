import { describe, it, expect } from 'vitest';
import { classifySyncFailure } from './syncManager.js';

// Le cœur du durcissement : un élément de la file n'est JAMAIS abandonné.
// Il est soit suspendu (rejet définitif, relancé sur « Réessayer » ou après
// reconnexion), soit retenté indéfiniment (échec passager). Aucune des deux
// branches ne supprime la saisie.

describe('classifySyncFailure — politique « on n\'abandonne jamais une saisie »', () => {
  it('suspend un rejet définitif : accès refusé', () => {
    expect(classifySyncFailure('Accès refusé')).toEqual({ suspended: true });
    expect(classifySyncFailure('Enregistrement refusé par le serveur.')).toEqual({ suspended: true });
  });

  it('suspend un rejet définitif : 401 / 403', () => {
    expect(classifySyncFailure('POST /rest/v1/... 403 (Forbidden)')).toEqual({ suspended: true });
    expect(classifySyncFailure('401 Unauthorized')).toEqual({ suspended: true });
  });

  it('suspend un code d\'accès introuvable (jamais abandonné, retryable)', () => {
    expect(classifySyncFailure("Code d'accès absent pour cette école")).toEqual({ suspended: true });
    expect(classifySyncFailure('Code d’accès absent pour cette école (accent).')).toEqual({ suspended: true });
  });

  it('suspend les erreurs JWT / clé API invalide', () => {
    expect(classifySyncFailure('Invalid API key')).toEqual({ suspended: true });
    expect(classifySyncFailure('JWT expired')).toEqual({ suspended: true });
  });

  it('ne suspend PAS une panne réseau (retentée indéfiniment)', () => {
    expect(classifySyncFailure('Failed to fetch')).toEqual({ suspended: false });
    expect(classifySyncFailure('NetworkError when attempting to fetch resource.')).toEqual({ suspended: false });
    expect(classifySyncFailure('La requête a échoué (réseau)')).toEqual({ suspended: false });
    expect(classifySyncFailure('connection refused')).toEqual({ suspended: false });
  });

  it('ne suspend PAS un conflit de version (récupéré par la fusion client)', () => {
    expect(classifySyncFailure('Conflit de version')).toEqual({ suspended: false });
  });

  it('ne suspend PAS un timeout / abort', () => {
    expect(classifySyncFailure('Timeout exceeded')).toEqual({ suspended: false });
    expect(classifySyncFailure('The operation was aborted.')).toEqual({ suspended: false });
  });

  it('traite une erreur vide/inconnue comme passagère (aucune perte)', () => {
    expect(classifySyncFailure('')).toEqual({ suspended: false });
    expect(classifySyncFailure()).toEqual({ suspended: false });
    expect(classifySyncFailure('Erreur de synchronisation serveur')).toEqual({ suspended: false });
  });
});
describe('isDormantItem', () => {
  it('un élément suspendu faute de code d\'accès est dormant (aucune alerte)', async () => {
    const { isDormantItem } = await import('./syncManager.js');
    expect(isDormantItem({ suspended: true, lastError: 'Code d’accès absent pour cette école' })).toBe(true);
    expect(isDormantItem({ suspended: true, lastError: "Code d'accès absent pour cette école" })).toBe(true);
  });
  it('un vrai rejet serveur ou un échec réseau n\'est pas dormant', async () => {
    const { isDormantItem } = await import('./syncManager.js');
    expect(isDormantItem({ suspended: true, lastError: 'Accès refusé' })).toBe(false);
    expect(isDormantItem({ suspended: false, lastError: 'Code d’accès absent pour cette école' })).toBe(false);
    expect(isDormantItem(null)).toBe(false);
  });
});
