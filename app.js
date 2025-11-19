// app.js
// ===================================================================
// Superviseur Agents – utilisation correcte du E-UC Plugins SDK
// - Import du SDK via CDN (ESM) comme tu l’avais déjà
// - Initialisation App + récupération du contexte
// - Appels API avec X-Auth-Token vers /api/agentd/1.0/agents
// ===================================================================

import { App } from 'https://cdn.jsdelivr.net/npm/@wazo/euc-plugins-sdk@latest/lib/esm/app.js';

console.log('[Superviseur] Chargement du plugin…');

const app = new App();

// Réfs DOM
const statusEl = document.getElementById('status');
const tbodyEl = document.getElementById('agents-body');

// Petit helper pour le bandeau de statut
function setStatus(message, type = 'info') {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.className = 'status';
  statusEl.classList.add(`status--${type}`);
}

// Helpers table
function showLoadingRow(message = 'Chargement des agents…') {
  if (!tbodyEl) return;
  tbodyEl.innerHTML = `
    <tr>
      <td colspan="4" class="loading-row">${message}</td>
    </tr>
  `;
}

function showErrorRow(message) {
  if (!tbodyEl) return;
  tbodyEl.innerHTML = `
    <tr>
      <td colspan="4" class="error-row">${message}</td>
    </tr>
  `;
}

// Création d’un client API basé sur le host + token du contexte
function createApiClient(baseUrl, token) {
  return async function callApi(path, options = {}) {
    const url = `${baseUrl}${path}`;

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Auth-Token': token,          // ✔ utilisation correcte du token
      ...(options.headers || {}),
    };

    console.log('[Superviseur] Appel API', url, options.method || 'GET');

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[Superviseur] Erreur API', res.status, url, text);

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Accès refusé (${res.status}). Vérifiez les droits Call Center / Agents pour cet utilisateur.`
        );
      }

      throw new Error(`Erreur API ${res.status}: ${text || res.statusText}`);
    }

    if (res.status === 204) {
      return null;
    }

    try {
      return await res.json();
    } catch {
      return null;
    }
  };
}

// Rendu des agents dans le tableau
function renderAgents(agents) {
  if (!tbodyEl) return;

  if (!agents || agents.length === 0) {
    tbodyEl.innerHTML = `
      <tr>
        <td colspan="4" class="empty-row">Aucun agent trouvé.</td>
      </tr>
    `;
    return;
  }

  tbodyEl.innerHTML = '';

  agents.forEach((agent) => {
    const tr = document.createElement('tr');

    const name =
      agent.display_name ||
      agent.name ||
      agent.number ||
      `Agent ${agent.id || ''}`;

    const status = agent.logged ? (agent.paused ? 'En pause' : 'Connecté') : 'Déconnecté';
    const paused = agent.paused ? 'Oui' : 'Non';

    tr.innerHTML = `
      <td>${name}</td>
      <td>${status}</td>
      <td>${paused}</td>
      <td>—</td>
    `;

    tbodyEl.appendChild(tr);
  });
}

// Chargement de la liste des agents
async function loadAgents(api) {
  try {
    setStatus('Chargement des agents…', 'info');
    showLoadingRow();

    const data = await api('/api/agentd/1.0/agents', { method: 'GET' });

    console.log('[Superviseur] Réponse /agents :', data);

    // suivant la version de la stack : tableau direct, ou { items: [...] }, ou { agents: [...] }
    const agents = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.agents)
      ? data.agents
      : [];

    renderAgents(agents);
    setStatus('Agents chargés.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur loadAgents :', err);
    setStatus(err.message || 'Erreur lors de la récupération de la liste des agents.', 'error');
    showErrorRow('Erreur lors du chargement des agents.');
  }
}

// Initialisation du plugin
(async () => {
  try {
    setStatus('Initialisation du plugin…', 'info');
    showLoadingRow('Initialisation du plugin…');

    await app.initialize();                // ✔ conforme à la doc E-UC
    const context = app.getContext();      // ✔ contexte complet (user, host, token, tenant, …)
    console.log('[Superviseur] Contexte reçu :', context);

    // On utilise le host et le token utilisateur
    const stackHost = context.user.host;   // ex: "voice.adexgroup.fr"
    const token = context.user.token;

    if (!stackHost || !token) {
      throw new Error('Host ou token manquant dans le contexte Wazo.');
    }

    const baseUrl = `https://${stackHost}`;
    console.log('[Superviseur] Stack host :', baseUrl);

    const api = createApiClient(baseUrl, token);

    // Appel réel vers agentd
    await loadAgents(api);
  } catch (err) {
    console.error('[Superviseur] Erreur init :', err);
    setStatus(err.message || 'Erreur durant l’initialisation du plugin.', 'error');
    showErrorRow('Erreur lors du chargement des agents.');
  }
})();
