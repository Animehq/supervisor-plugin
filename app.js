// app.js - Plugin "Superviseur Agents" pour Wazo E-UC
// Version simple, suivant la doc E-UC Plugins SDK

(function () {
  const log = (...args) => console.log('[Superviseur]', ...args);
  const showErrorBanner = (message) => {
    const banner = document.getElementById('supervisor-error');
    if (banner) {
      banner.textContent = message;
      banner.style.display = 'block';
    }
  };

  const showLoading = (message) => {
    const row = document.getElementById('supervisor-loading-row');
    if (row) {
      row.textContent = message || 'Chargement des agents...';
      row.style.display = 'table-row';
    }
  };

  const hideLoading = () => {
    const row = document.getElementById('supervisor-loading-row');
    if (row) {
      row.style.display = 'none';
    }
  };

  const clearAgentsTable = () => {
    const tbody = document.getElementById('supervisor-agents-body');
    if (tbody) {
      while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
      }
    }
  };

  const renderAgents = (agents) => {
    clearAgentsTable();

    const tbody = document.getElementById('supervisor-agents-body');
    if (!tbody) {
      log('Aucun <tbody id="supervisor-agents-body"> trouvé dans le HTML');
      return;
    }

    if (!agents || !agents.length) {
      showLoading('Aucun agent trouvé.');
      return;
    }

    agents.forEach((agent) => {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = agent.name || agent.username || agent.uuid || '—';

      const tdState = document.createElement('td');
      tdState.textContent = agent.state || agent.status || '—';

      const tdPause = document.createElement('td');
      tdPause.textContent = agent.paused ? 'En pause' : 'Disponible';

      const tdActions = document.createElement('td');
      tdActions.textContent = '—'; // on remplira plus tard (pause, redirection…)

      tr.appendChild(tdName);
      tr.appendChild(tdState);
      tr.appendChild(tdPause);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    });
  };

  // --- Appel API agentd (correct suivant la doc) ------------------------

  const fetchAgents = async ({ host, token, tenantUuid }) => {
    try {
      hideLoading();
      showLoading('Chargement des agents…');

      // host peut être "voice.adexgroup.fr" ou déjà une URL complète
      const baseUrl = host.startsWith('http') ? host : `https://${host}`;

      const response = await fetch(`${baseUrl}/api/agentd/1.0/agents`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          ...(tenantUuid ? { 'Wazo-Tenant': tenantUuid } : {}),
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API agentd ${response.status} ${response.statusText} – ${text}`);
      }

      const data = await response.json();
      const items = data.items || data || [];
      log('Agents reçus :', items);
      hideLoading();
      renderAgents(items);
    } catch (error) {
      console.error('[Superviseur] Erreur fetchAgents', error);
      hideLoading();
      showErrorBanner('Erreur lors du chargement des agents.');
    }
  };

  // --- Initialisation du plugin ----------------------------------------

  const init = async () => {
    try {
      log('Chargement du plugin…');

      const sdk = window.WazoEUCPluginsSDK;
      if (!sdk || !sdk.App) {
        showErrorBanner('SDK Wazo E-UC introuvable dans la page.');
        console.error('[Superviseur] window.WazoEUCPluginsSDK.App manquant');
        return;
      }

      const app = new sdk.App();

      const context = await app.getContext();
      log('Contexte reçu :', context);

      const user = context.user || {};
      const appInfo = context.app || {};

      const token = user.token;
      const host = user.host || appInfo.host;
      const tenantUuid = user.tenant_uuid || user.tenantUuid || appInfo.tenant_uuid;

      if (!token || !host) {
        showErrorBanner('Host ou token manquant dans le contexte Wazo.');
        console.error('[Superviseur] Contexte incomplet', { host, token, tenantUuid });
        return;
      }

      await fetchAgents({ host, token, tenantUuid });
    } catch (error) {
      console.error('[Superviseur] Erreur pendant init :', error);
      showErrorBanner('Erreur lors de l’initialisation du plugin.');
    }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
