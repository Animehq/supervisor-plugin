// app.js
// ===================================================================
// Superviseur Agents – affichage par files d’attente + actions + temps réel
//   + Join / Spy / Whisper via calld
//   + Transfert mobile via callforward inconditionnel
//   + Stats files sur la journée (9h–18h) via call-logd
// ===================================================================

import { App } from 'https://cdn.jsdelivr.net/npm/@wazo/euc-plugins-sdk@latest/lib/esm/app.js';

// -------------------------------------------------------------------
// Config supervision
// -------------------------------------------------------------------

// Préfixes de supervision (à adapter à ton dialplan)
// Exemple : *301<ext> = join, *302<ext> = spy, *303<ext> = whisper
const SUPERVISION_PREFIXES = {
  join: '*301',
  spy: '*302',
  whisper: '*303',
};

// Fenêtre de stats journalières (9h–18h)
const STATS_START_HOUR = 9;
const STATS_END_HOUR = 18;

// -------------------------------------------------------------------
// Références DOM & état global
// -------------------------------------------------------------------

const statusEl = document.getElementById('status');
const containerEl = document.getElementById('queues-container');
const compactToggleEl = document.getElementById('compact-toggle');
const themeToggleEl = document.getElementById('theme-toggle');
const refreshBtn = document.getElementById('refresh-btn');

// Auto-refresh (optimisé) : toutes les 15s
const AUTO_REFRESH_INTERVAL_MS = 15000;
let autoRefreshTimer = null;
let isAutoRefreshing = false;

const state = {
  api: null,
  baseUrl: null,
  token: null,
  groups: new Map(),
  queuesMeta: new Map(),
  queueStats: new Map(), // 👈 stats call-logd par queue_id
  userForwards: new Map(), // 👈 renvoi inconditionnel par userUuid
  websocket: null,
  realtimeReloadScheduled: false,
};

const uiState = {
  compact: true, // compact actif par défaut
  dark: true,    // dark actif par défaut
};

// -------------------------------------------------------------------
// UI : toggles compact / thème (version corrigée avec .switch-label)
// -------------------------------------------------------------------

function syncCompactUI() {
  const isCompact = uiState.compact;
  document.body.classList.toggle('is-compact', isCompact);

  if (compactToggleEl) {
    compactToggleEl.classList.toggle('toggle--active', isCompact);
    compactToggleEl.setAttribute('aria-pressed', String(isCompact));

    const row = compactToggleEl.closest('.switch-row');
    const label = row ? row.querySelector('.switch-label') : null;
    if (label) {
      // On affiche l’action possible (comme sur ton screen)
      label.textContent = isCompact ? 'Mode normal' : 'Mode compact';
    }
  }
}

function syncThemeUI() {
  const isDark = uiState.dark;
  document.body.classList.toggle('is-dark', isDark);

  if (themeToggleEl) {
    themeToggleEl.classList.toggle('toggle--active', isDark);
    themeToggleEl.setAttribute('aria-pressed', String(isDark));

    const row = themeToggleEl.closest('.switch-row');
    const label = row ? row.querySelector('.switch-label') : null;
    if (label) {
      // On affiche l’action possible (passer en clair / en sombre)
      label.textContent = isDark ? 'Thème clair' : 'Thème sombre';
    }
  }
}

// Écouteurs sur les toggles
if (compactToggleEl) {
  compactToggleEl.addEventListener('click', () => {
    uiState.compact = !uiState.compact;
    syncCompactUI();
  });
}

if (themeToggleEl) {
  themeToggleEl.addEventListener('click', () => {
    uiState.dark = !uiState.dark;
    syncThemeUI();
  });
}

// Appliquer l’état initial (compact + dark actifs)
syncCompactUI();
syncThemeUI();

// -------------------------------------------------------------------
// UI helpers
// -------------------------------------------------------------------

function setStatus(message, type = 'info') {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message || '';
  statusEl.className = 'status';
  statusEl.classList.add(`status--${type}`);
}

function clearContainer() {
  if (!containerEl) return;
  containerEl.innerHTML = '';
}

function renderEmptyState(message) {
  clearContainer();
  if (!containerEl) return;
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = message;
  containerEl.appendChild(div);
}

function createActionButton(label, variant = 'secondary') {
  const baseClasses = 'btn btn--sm';
  let variantClasses = 'btn--secondary';

  if (variant === 'primary') {
    variantClasses = 'btn--primary';
  } else if (variant === 'danger') {
    variantClasses = 'btn--danger';
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${baseClasses} ${variantClasses}`;
  btn.textContent = label;
  return btn;
}

function setLoginButtonStyle(btn, isLogged) {
  btn.classList.remove('btn--primary', 'btn--danger');
  btn.classList.add('btn', 'btn--sm');

  if (isLogged) {
    btn.classList.add('btn--danger');
  } else {
    btn.classList.add('btn--primary');
  }
}

// -------------------------------------------------------------------
// Client API Wazo générique (contexte E-UC commercial)
// -------------------------------------------------------------------

function createApiClient(baseUrl, token) {
  return async function callApi(path, options = {}) {
    const url = `${baseUrl}${path}`;

    let opts = { ...options };

    const headers = {
      Accept: 'application/json',
      'X-Auth-Token': token,
      ...(opts.headers || {}),
    };

    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts = { ...opts, body: JSON.stringify(opts.body) };
    }

    console.log('[Superviseur] Appel API', opts.method || 'GET', url, opts);

    const res = await fetch(url, {
      ...opts,
      headers,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[Superviseur] Erreur API', res.status, url, text);

      // 🔐 Sécurité token expiré côté API REST
      if (res.status === 401 || res.status === 403) {
        const lower = (text || '').toLowerCase();

        // Beaucoup de stacks Wazo renvoient "expired" ou "token" dans le message
        if (lower.includes('expired') || lower.includes('token')) {
          setStatus('Session expirée — rechargement…', 'error');
          setTimeout(() => {
            window.location.reload();
          }, 800);
          return; // on stoppe ici
        }

        throw new Error(
          `Accès refusé (${res.status}). Vérifiez les droits Call Center / Agents.`
        );
      }

      throw new Error(`Erreur API ${res.status}: ${text || res.statusText}`);
    }

    if (res.status === 204) return null;

    try {
      return await res.json();
    } catch {
      return null;
    }
  };
}

// Couleur personnalisée par file d'attente à partir de son nom
function queueColorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// -------------------------------------------------------------------
// Normalisation / mapping
// -------------------------------------------------------------------

function normalizeCollection(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.rows)) return raw.rows;
  return [];
}

// users → maps
function buildUsersMaps(usersRaw) {
  const users = normalizeCollection(usersRaw);
  const usersByUuid = new Map();
  const usersByExt = new Map();

  users.forEach((user) => {
    const displayName =
      `${user.firstname || ''} ${user.lastname || ''}`.trim() ||
      user.display_name ||
      user.name ||
      user.username ||
      user.email ||
      `Utilisateur ${user.id || user.uuid || ''}`;

    let extension = null;

    if (Array.isArray(user.lines)) {
      for (const line of user.lines) {
        const exts = line.extensions || [];
        for (const ext of exts) {
          if (ext && ext.exten) {
            extension = String(ext.exten);
            break;
          }
        }
        if (extension) break;
      }
    }

    const uuid = user.uuid || user.id || null;
    if (uuid) {
      usersByUuid.set(uuid, { name: displayName, extension, uuid });
    }
    if (extension) {
      usersByExt.set(extension, { name: displayName, uuid: uuid || null });
    }
  });

  console.log('[Superviseur] maps usersByUuid/usersByExt', usersByUuid, usersByExt);
  return { usersByUuid, usersByExt };
}

// agents → maps (par extension / id / uuid)
function buildAgentsMaps(agentsRaw) {
  const agents = normalizeCollection(agentsRaw);
  const byExt = new Map();
  const byId = new Map();
  const byUuid = new Map();

  agents.forEach((agent) => {
    const id = agent.id ?? agent.uuid;
    const uuid = agent.uuid || null;
    const extensionRaw = agent.number || agent.extension || null;
    const extension = extensionRaw ? String(extensionRaw) : null;

    const info = {
      id,
      uuid,
      extension,
      number: agent.number || extension,
      logged: !!agent.logged,
      paused: !!agent.paused,
      raw: agent,
    };

    if (extension) byExt.set(extension, info);
    if (id != null) byId.set(id, info);
    if (uuid) byUuid.set(uuid, info);
  });

  console.log('[Superviseur] Map agentsByExt', byExt);
  return { agents, byExt, byId, byUuid };
}

// Résout extension + context réels pour login via confd
async function resolveAgentLoginTarget(agent, api) {
  if (agent.loginExtension && agent.loginContext) {
    return {
      extension: agent.loginExtension,
      context: agent.loginContext,
    };
  }

  const guessExt = agent.extension || agent.number;
  if (!guessExt) {
    throw new Error(
      `Impossible de déterminer l'extension pour l'agent ${agent.name} (id=${agent.id}).`
    );
  }

  const query = `/api/confd/1.1/extensions?recurse=true&exten=${encodeURIComponent(
    guessExt
  )}`;
  console.log('[Superviseur] Résolution context via confd:', query);

  const result = await api(query, { method: 'GET' });
  const items = (result && (result.items || result)) || [];
  if (!items.length) {
    throw new Error(
      `Aucune extension '${guessExt}' trouvée dans confd pour l'agent ${agent.name} (id=${agent.id}).`
    );
  }

  const ext = items[0];
  const extension = String(ext.exten);
  const context = ext.context;

  if (!context) {
    throw new Error(
      `Extension '${extension}' trouvée sans context dans confd pour l'agent ${agent.name} (id=${agent.id}).`
    );
  }

  agent.loginExtension = extension;
  agent.loginContext = context;

  console.log(
    '[Superviseur] Context résolu:',
    agent.name,
    '→',
    extension,
    '@',
    context
  );

  return { extension, context };
}

// queues → regroupement agents par file d’attente + meta queue
function groupAgentsByQueue(queuesRaw, usersRaw, agentsRaw) {
  const queues = normalizeCollection(queuesRaw);
  const { usersByUuid, usersByExt } = buildUsersMaps(usersRaw);
  const { byExt, byId, byUuid } = buildAgentsMaps(agentsRaw);

  const groups = new Map(); // queueName -> rows[]
  const queuesMeta = new Map(); // queueName -> { id, raw }

  const ensureGroup = (label) => {
    if (!groups.has(label)) groups.set(label, []);
    return groups.get(label);
  };

  queues.forEach((queue) => {
    const queueLabel =
      queue.display_name || queue.label || queue.name || 'File d’attente';
    const queueId = queue.queue_id ?? queue.id;

    queuesMeta.set(queueLabel, { id: queueId, raw: queue });

    const members = queue.members || {};
    const qGroup = ensureGroup(queueLabel);

    const entries = [];

    if (Array.isArray(members.users)) {
      members.users.forEach((u) => entries.push({ kind: 'user', ref: u }));
    }
    if (Array.isArray(members.agents)) {
      members.agents.forEach((a) => entries.push({ kind: 'agent', ref: a }));
    }

    entries.forEach(({ kind, ref }) => {
      let agentInfo = null;
      let name = null;
      let extension = null;
      let userUuid = null;

      if (kind === 'user') {
        const key = ref.uuid || ref.id;
        const userInfo = key ? usersByUuid.get(key) : null;
        if (!userInfo) {
          console.warn(
            '[Superviseur] Membre user inconnu dans la file',
            queueLabel,
            ref
          );
        } else {
          name = userInfo.name;
          extension = userInfo.extension || null;
          userUuid = key || null;
          if (extension) {
            agentInfo = byExt.get(String(extension)) || null;
          }
        }
      } else if (kind === 'agent') {
        const keyUuid = ref.uuid || ref.agent_uuid;
        const keyId = ref.id || ref.agent_id;
        agentInfo =
          (keyUuid && byUuid.get(keyUuid)) ||
          (keyId != null && byId.get(keyId)) ||
          null;

        if (!agentInfo) {
          console.warn(
            '[Superviseur] Membre agent inconnu dans la file',
            queueLabel,
            ref
          );
        } else {
          extension = agentInfo.extension || null;

          if (extension) {
            const extInfo = usersByExt.get(String(extension));
            if (extInfo) {
              if (!name) name = extInfo.name;
              userUuid = extInfo.uuid || null;
            }
          }
        }
      }

      if (!agentInfo && !extension && ref.number) {
        extension = String(ref.number);
        agentInfo = byExt.get(extension) || null;
      }

      if (!name) {
        if (agentInfo) {
          name =
            agentInfo.raw?.display_name ||
            agentInfo.raw?.name ||
            (agentInfo.extension
              ? `Agent ${agentInfo.extension}`
              : `Agent ${agentInfo.id}`);
        } else {
          name = 'Inconnu';
        }
      }

      const row = {
        id: agentInfo?.id ?? null,
        extension: extension || agentInfo?.extension || null,
        number: agentInfo?.number || null,
        name,
        logged: agentInfo?.logged ?? false,
        paused: agentInfo?.paused ?? false,
        queueId,
        queueLabel,
        userUuid, // 👈 pour transfert mobile
      };

      qGroup.push(row);
    });
  });

  console.log('[Superviseur] Groupes construits', groups, queuesMeta);
  return { groups, queuesMeta };
}

// -------------------------------------------------------------------
// Statuts / stats
// -------------------------------------------------------------------

function getStatusInfo(agent) {
  if (!agent.logged) {
    return { text: 'Déconnecté', css: 'pill--offline' };
  }
  if (agent.paused) {
    return { text: 'En pause', css: 'pill--paused' };
  }
  return { text: 'Connecté', css: 'pill--online' };
}


function computeQueuePresence(rows) {
  let total = rows.length;
  let logged = 0;
  let paused = 0;

  rows.forEach((a) => {
    if (a.logged) {
      logged += 1;
      if (a.paused) paused += 1;
    }
  });

  const offline = total - logged;

  return {
    totalAgents: total,
    logged,
    paused,
    offline,
  };
}

// -------------------------------------------------------------------
// Drag & drop – déplacement d’un agent entre files
// -------------------------------------------------------------------

async function moveAgentBetweenQueues(agentId, fromQueueId, toQueueId, api) {
  if (!agentId || !fromQueueId || !toQueueId || fromQueueId === toQueueId) {
    return;
  }

  try {
    setStatus('Déplacement de l’agent…', 'info');

    await api(`/api/agentd/1.0/agents/by-id/${agentId}/remove`, {
      method: 'POST',
      body: { queue_id: fromQueueId },
    });

    await api(`/api/agentd/1.0/agents/by-id/${agentId}/add`, {
      method: 'POST',
      body: { queue_id: toQueueId },
    });

    await loadData(api);
    setStatus('Agent déplacé.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur moveAgentBetweenQueues', err);
    alert(
      'Erreur lors du déplacement de l’agent entre les files.\n' +
        (err.message || '')
    );
    setStatus('Erreur lors du déplacement de l’agent.', 'error');
  }
}

// Synchronise toutes les lignes DOM d'un même agent (cas : agent dans plusieurs files)
function syncAgentDom(agent) {
  if (!agent || !agent.id || !containerEl) return;

  const rows = containerEl.querySelectorAll(
    `tr[data-agent-id="${agent.id}"]`
  );

  rows.forEach((row) => {
    const statusTd = row.querySelector('.col-status');
    const pauseBtn = row.querySelector('.agent-pause-btn');
    const loginBtn = row.querySelector('.agent-login-btn');

    const statusInfo = getStatusInfo(agent);

    if (statusTd) {
      statusTd.innerHTML = `<span class="pill ${statusInfo.css}">${statusInfo.text}</span>`;
    }

    if (pauseBtn) {
      pauseBtn.disabled = !agent.logged;
      pauseBtn.textContent = agent.paused ? 'Reprendre' : 'Pause';
      pauseBtn.classList.toggle('btn--pause-active', agent.logged && agent.paused);
      pauseBtn.classList.toggle('btn--pause-disabled', !agent.logged);
    }

    if (loginBtn) {
      loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
      setLoginButtonStyle(loginBtn, agent.logged);
    }
  });
}

// -------------------------------------------------------------------
// Supervision et transfert mobile
// -------------------------------------------------------------------

async function superviseAgentCall(mode, agent, api) {
  const prefix = SUPERVISION_PREFIXES[mode];
  if (!prefix) {
    alert(`Préfixe supervision non configuré pour le mode ${mode}.`);
    return;
  }
  const ext = agent.extension || agent.number;
  if (!ext) {
    alert(
      `Impossible de déterminer l'extension pour l'agent ${agent.name} (id=${agent.id}).`
    );
    return;
  }

  const target = `${prefix}${ext}`;
  try {
    const label =
      mode === 'join' ? 'Join' : mode === 'spy' ? 'Spy' : 'Whisper';
    setStatus(`${label} sur ${agent.name} (${ext})…`, 'info');

    await api('/api/calld/1.0/users/me/calls', {
      method: 'POST',
      body: { extension: target },
    });

    setStatus('Commande de supervision envoyée.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur superviseAgentCall', err);
    alert(
      `Erreur lors de la supervision (${mode}) de cet agent.\n` +
        (err.message || '')
    );
    setStatus('Erreur lors de la supervision.', 'error');
  }
}

// TRANSFERT MOBILE (renvoi inconditionnel correct via confd)
async function setUserMobileForward(userUuid, number, api) {
  if (!userUuid) {
    throw new Error('userUuid manquant pour configurer le transfert.');
  }

  const trimmed = (number || '').trim();
  const enabled = !!trimmed;

  const body = enabled
    ? { enabled: true, destination: trimmed }
    : { enabled: false, destination: null }; 

  // ✅ API confd correcte : /forwards/unconditional
  await api(
    `/api/confd/1.1/users/${encodeURIComponent(
      userUuid
    )}/forwards/unconditional`,
    {
      method: 'PUT',
      body,
    }
  );
}


// Charge les renvois inconditionnels pour une liste de users
async function loadUserForwards(api, userUuidSet) {
  const forwardsMap = new Map();
  const promises = [];

  for (const userUuid of userUuidSet) {
    const p = api(
      `/api/confd/1.1/users/${encodeURIComponent(
        userUuid
      )}/forwards/unconditional`,   // 👈 même chemin que setUserMobileForward
      { method: 'GET' }
    )
      .then((data) => {
        if (data && typeof data.enabled === 'boolean') {
          forwardsMap.set(userUuid, {
            enabled: !!data.enabled,
            destination: data.destination || '',
          });
        }
      })
      .catch((err) => {
        console.warn(
          '[Superviseur] Impossible de charger le renvoi pour',
          userUuid,
          err
        );
      });

    promises.push(p);
  }

  await Promise.all(promises);
  return forwardsMap;
}



// -------------------------------------------------------------------
// Rendu des files + actions
// -------------------------------------------------------------------

function renderQueues(groups, api, queuesMeta) {
  clearContainer();
  if (!containerEl) return;

  if (!groups.size) {
    renderEmptyState('Aucun agent trouvé.');
    return;
  }

  const SUPPORT_IT_PATTERN = /support\s*it/i;
  const PARKING_PATTERN = /(sans\s*file|hors\s*call\s*center|parking)/i;
  const SAV_PATTERN = /^sav\b/i;

  const allNames = Array.from(groups.keys());

  // File Support IT (prioritaire)
  const supportName = allNames.find((n) => SUPPORT_IT_PATTERN.test(n));

  // File "parking" (hors call center) détectée par motif, plus besoin du nom exact
  const parkingName = allNames.find((n) => PARKING_PATTERN.test(n));

  // Files SAV (bureautique, conso, etc.)
  const savNames = allNames.filter((n) => SAV_PATTERN.test(n));

  // Autres files
  const otherNames = allNames.filter(
    (n) =>
      n !== supportName &&
      n !== parkingName &&
      !savNames.includes(n)
  );

  // Petite fonction pour construire une carte de file
    const buildQueueCard = (queueName, rows) => {
    const queueMeta = queuesMeta.get(queueName) || {};
    const queueId = queueMeta.id || null;

    const section = document.createElement('section');
    section.className = 'queue-card';

    const color = queueColorFromName(queueName);
    section.style.borderLeft = `4px solid ${color}`;
    if (document.body.classList.contains('is-dark')) {
      section.style.boxShadow = `0 0 0 1px ${color}22, var(--shadow-card)`;
    }

    const isSupport = SUPPORT_IT_PATTERN.test(queueName);
    const isParking = PARKING_PATTERN.test(queueName);

    if (isSupport) {
      section.classList.add('queue-card--priority');
    }

    section.dataset.queueId = queueId || '';


    const header = document.createElement('header');
    header.className = 'queue-card__header';

    const titleWrapper = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = queueName;
    titleWrapper.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'queue-card__meta';

    const badgeAgents = document.createElement('span');
    badgeAgents.className = 'badge badge--light-blue';

    const badgePaused = document.createElement('span');
    badgePaused.className = 'badge badge--amber';

    const badgeOffline = document.createElement('span');
    badgeOffline.className = 'badge badge--muted';

    const badgeCalls = document.createElement('span');
    badgeCalls.className = 'badge badge--muted';

    const updateHeaderStats = () => {
      const presence = computeQueuePresence(rows);
      badgeAgents.textContent = `${presence.logged}/${presence.totalAgents} connectés`;
      badgePaused.textContent = `${presence.paused} en pause`;
      badgeOffline.textContent = `${presence.offline} off`;

      const callStats = state.queueStats.get(queueId);
      if (callStats) {
        const received =
          callStats.total_calls ??
          callStats.received ??
          callStats.calls ??
          0;
        const answered =
          callStats.answered_calls ?? callStats.answered ?? 0;
        const missed =
          callStats.missed_calls ?? callStats.missed ?? 0;
        badgeCalls.textContent = `Reçus: ${received} · Répondus: ${answered} · Manqués: ${missed} (9h–18h)`;
      } else {
        badgeCalls.textContent = 'Statistiques 9h–18h indisponibles';
      }
    };

    const flashUpdating = () => {
      section.classList.add('queue-card--updating');
      setTimeout(() => section.classList.remove('queue-card--updating'), 300);
    };

    updateHeaderStats();

    meta.appendChild(badgeAgents);
    meta.appendChild(badgePaused);
    meta.appendChild(badgeOffline);
    meta.appendChild(badgeCalls);

    // 🔍 Si c'est "Sans file d'attente", on ajoute une barre de recherche
     let searchInput = null;
    if (isParking) {
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.placeholder = 'Rechercher un utilisateur…';
      searchInput.className = 'queue-search-input';
      titleWrapper.appendChild(searchInput);
    }

    header.appendChild(titleWrapper);
    header.appendChild(meta);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'queue-card__body';

    const table = document.createElement('table');
    table.className = 'agents-table';
    table.dataset.queueId = queueId || '';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>NOM</th>
        <th>EXTENSION</th>
        <th>ÉTAT</th>
        <th>SUPERVISION</th>
        <th>TRANSFERT</th>
        <th class="col-actions">ACTIONS</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // DnD – cible
    table.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
    });

    table.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const queueIdTargetStr = table.dataset.queueId;
      const queueIdTarget = queueIdTargetStr ? Number(queueIdTargetStr) : null;
      if (!queueIdTarget) return;

      try {
        const data = ev.dataTransfer.getData('application/json');
        if (!data) return;
        const parsed = JSON.parse(data);
        const agentId = parsed.agentId;
        const fromQueueId = parsed.fromQueueId;

        if (!agentId || !fromQueueId || fromQueueId === queueIdTarget) return;

        await moveAgentBetweenQueues(agentId, fromQueueId, queueIdTarget, api);
      } catch (err) {
        console.error('[Superviseur] Erreur drop DnD', err);
      }
    });

    // Tri des agents dans la file
    const sortedRows = [...rows].sort((a, b) => {
      const nameA = (a.name || '').toLocaleLowerCase('fr-FR');
      const nameB = (b.name || '').toLocaleLowerCase('fr-FR');

      if (nameA === nameB) {
        const extA = a.extension || '';
        const extB = b.extension || '';
        return extA.localeCompare(extB, 'fr', { numeric: true });
      }

      return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
    });

    sortedRows.forEach((agent) => {
      const tr = document.createElement('tr');
      if (agent.id != null) {
        tr.dataset.agentId = String(agent.id);
      }
      if (agent.number || agent.extension) {
        tr.dataset.agentNumber = agent.number || agent.extension;
      }

      const statusInfo = getStatusInfo(agent);

      tr.innerHTML = `
        <td>${agent.name}</td>
        <td>${agent.extension || '—'}</td>
        <td class="col-status">
          <span class="pill ${statusInfo.css}">${statusInfo.text}</span>
        </td>
        <td class="col-supervision"></td>
        <td class="col-transfer"></td>
        <td class="col-actions"></td>
      `;

      const supervisionCell = tr.querySelector('.col-supervision');
      const transferCell = tr.querySelector('.col-transfer');
      const actionsCell = tr.querySelector('.col-actions');

      tr.dataset.agentId = agent.id || '';
      tr.dataset.queueId = agent.queueId || '';

      if (agent.id && agent.queueId) {
        tr.draggable = true;

        tr.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.effectAllowed = 'move';
          tr.classList.add('dragging');
          ev.dataTransfer.setData(
            'application/json',
            JSON.stringify({
              agentId: agent.id,
              fromQueueId: agent.queueId,
            })
          );
        });

        tr.addEventListener('dragend', () => {
          tr.classList.remove('dragging');
        });
      }

      // Si pas d'id agent → actions désactivées
      if (!agent.id) {
        const pauseBtn = createActionButton('Pause', 'secondary');
        const loginBtn = createActionButton('Login', 'primary');
        pauseBtn.disabled = true;
        loginBtn.disabled = true;
        actionsCell.appendChild(pauseBtn);
        actionsCell.appendChild(loginBtn);
        tbody.appendChild(tr);
        return;
      }

      // SUPERVISION (Join / Spy / Whisper)
      const joinBtn = createActionButton('Join', 'secondary');
      const spyBtn = createActionButton('Spy', 'secondary');
      const whisperBtn = createActionButton('Whisper', 'secondary');

      [joinBtn, spyBtn, whisperBtn].forEach((btn) => {
        btn.disabled = !agent.logged;
      });

      joinBtn.addEventListener('click', () =>
        superviseAgentCall('join', agent, api)
      );
      spyBtn.addEventListener('click', () =>
        superviseAgentCall('spy', agent, api)
      );
      whisperBtn.addEventListener('click', () =>
        superviseAgentCall('whisper', agent, api)
      );

      supervisionCell.appendChild(joinBtn);
      supervisionCell.appendChild(spyBtn);
      supervisionCell.appendChild(whisperBtn);

                  // TRANSFERT MOBILE (renvoi inconditionnel, 1 seul bouton ON/OFF)
      if (agent.userUuid) {
        const wrapper = document.createElement('div');
        wrapper.className = 'transfer-control';

        const input = document.createElement('input');
        input.type = 'tel';
        input.placeholder = 'Portable…';
        input.className = 'transfer-input';

        const toggleBtn = createActionButton('ON', 'primary');

        // État initial basé sur state.userForwards (si disponible)
        let forwardEnabled = false; // true = renvoi actif
        let forwardNumber = '';

        if (state.userForwards && state.userForwards.has(agent.userUuid)) {
          const fw = state.userForwards.get(agent.userUuid);
          forwardEnabled = !!fw.enabled;
          forwardNumber = fw.destination || '';
        }

        const syncForwardUi = () => {
          input.value = forwardNumber || '';

          toggleBtn.classList.remove('btn--primary', 'btn--danger');

          if (forwardEnabled) {
            // Renvoi actif -> OFF rouge
            toggleBtn.textContent = 'OFF';
            toggleBtn.classList.add('btn--danger');
          } else {
            // Pas de renvoi -> ON vert
            toggleBtn.textContent = 'ON';
            toggleBtn.classList.add('btn--primary');
          }
        };

        syncForwardUi();

        toggleBtn.addEventListener('click', async () => {
          if (!forwardEnabled) {
            // Activer le renvoi
            const num = input.value.trim();
            if (!num) {
              alert('Merci de renseigner un numéro de portable.');
              return;
            }
            try {
              setStatus(
                `Activation du transfert vers ${num} pour ${agent.name}…`,
                'info'
              );
              await setUserMobileForward(agent.userUuid, num, api);
              forwardEnabled = true;
              forwardNumber = num;
              syncForwardUi();
              setStatus('Transfert activé.', 'success');
            } catch (err) {
              console.error('[Superviseur] Erreur transfert mobile ON', err);
              alert(
                'Erreur lors de l’activation du transfert.\n' +
                  (err.message || '')
              );
              setStatus('Erreur transfert mobile.', 'error');
            }
          } else {
            // Désactiver le renvoi
            try {
              setStatus(
                `Désactivation du transfert mobile pour ${agent.name}…`,
                'info'
              );
              await setUserMobileForward(agent.userUuid, '', api);
              forwardEnabled = false;
              forwardNumber = '';
              syncForwardUi();
              setStatus('Transfert désactivé.', 'success');
            } catch (err) {
              console.error('[Superviseur] Erreur transfert mobile OFF', err);
              alert(
                'Erreur lors de la désactivation du transfert.\n' +
                  (err.message || '')
              );
              setStatus('Erreur transfert mobile.', 'error');
            }
          }
        });

        wrapper.appendChild(input);
        wrapper.appendChild(toggleBtn);
        transferCell.appendChild(wrapper);
      } else {
        transferCell.textContent = '—';
      }




      // BOUTON PAUSE / REPRENDRE
      const pauseBtn = createActionButton(
        agent.paused ? 'Reprendre' : 'Pause',
        'secondary'
      );
      pauseBtn.disabled = !agent.logged;
      pauseBtn.classList.add('agent-pause-btn');

      pauseBtn.addEventListener('click', async () => {
        try {
          pauseBtn.disabled = true;

          const agentNumber = agent.number || agent.extension;
          if (!agentNumber) {
            throw new Error(
              `Numéro d'agent introuvable pour ${agent.name} (id=${agent.id}).`
            );
          }

          const basePath = `/api/agentd/1.0/agents/by-number/${agentNumber}`;
          const path = agent.paused
            ? `${basePath}/unpause`
            : `${basePath}/pause`;

          const options = { method: 'POST' };

          if (!agent.paused) {
            options.body = { reason: 'plugin-superviseur' };
          }

          console.log('[Superviseur] PAUSE/UNPAUSE', path, options, agent);
          await api(path, options);

          agent.paused = !agent.paused;

          syncAgentDom(agent);
          updateHeaderStats();
          flashUpdating();
        } catch (err) {
          console.error('[Superviseur] Erreur pause/reprendre', err);
          alert(
            'Erreur lors du changement de pause de cet agent.\n' +
              (err.message || '')
          );
        } finally {
          pauseBtn.disabled = !agent.logged;
        }
      });

      // BOUTON LOGIN / LOGOUT
      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
      setLoginButtonStyle(loginBtn, agent.logged);
      loginBtn.classList.add('agent-login-btn');

      loginBtn.addEventListener('click', async () => {
        try {
          loginBtn.disabled = true;

          const basePath = `/api/agentd/1.0/agents/by-id/${agent.id}`;
          const isLoggingIn = !agent.logged;

          const path = isLoggingIn
            ? `${basePath}/login`
            : `${basePath}/logoff`;

          const options = { method: 'POST' };

          if (isLoggingIn) {
            const { extension, context } = await resolveAgentLoginTarget(
              agent,
              api
            );
            options.body = { extension, context };
          }

          console.log('[Superviseur] LOGIN/LOGOFF', path, options, agent);
          await api(path, options);

          agent.logged = !agent.logged;
          if (!agent.logged) {
            agent.paused = false;
          }

          syncAgentDom(agent);
          updateHeaderStats();
          flashUpdating();
        } catch (err) {
          console.error('[Superviseur] Erreur login/logout', err);
          alert(
            'Erreur lors du login/logout de cet agent.\n' +
              (err.message || '')
          );
        } finally {
          loginBtn.disabled = false;
        }
      });

      actionsCell.appendChild(pauseBtn);
      actionsCell.appendChild(loginBtn);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    body.appendChild(table);
    section.appendChild(body);

    // 🔎 Filtre de recherche pour "Sans file d'attente"
    if (isParking && searchInput) {
      searchInput.addEventListener('input', () => {
        const term = searchInput.value.toLowerCase().trim();
        tbody.querySelectorAll('tr').forEach((row) => {
          const name = row.cells[0]?.textContent?.toLowerCase() || '';
          const ext = row.cells[1]?.textContent?.toLowerCase() || '';
          const visible =
            !term || name.includes(term) || ext.includes(term);
          row.style.display = visible ? '' : 'none';
        });
      });
    }

    return section;
  };

    // 1) Ligne spéciale : Support IT + file "parking" (à droite)
  if (supportName || parkingName) {
    const row = document.createElement('div');
    row.className = 'queues-row';

    if (supportName) {
      const supportRows = groups.get(supportName) || [];
      row.appendChild(buildQueueCard(supportName, supportRows));
    }

    if (parkingName) {
      const parkingRows = groups.get(parkingName) || [];
      row.appendChild(buildQueueCard(parkingName, parkingRows));
    }

    containerEl.appendChild(row);
  }

  // 2) Ligne SAV : toutes les files SAV sur une même rangée
  if (savNames.length) {
    const savRow = document.createElement('div');
    savRow.className = 'queues-row';

    savNames
      .sort((a, b) => a.localeCompare(b, 'fr'))
      .forEach((queueName) => {
        const rows = groups.get(queueName) || [];
        savRow.appendChild(buildQueueCard(queueName, rows));
      });

    containerEl.appendChild(savRow);
  }

  // 3) Autres files (une carte par ligne)
  otherNames
    .sort((a, b) => a.localeCompare(b, 'fr'))
    .forEach((queueName) => {
      const rows = groups.get(queueName) || [];
      containerEl.appendChild(buildQueueCard(queueName, rows));
    });
}



// -------------------------------------------------------------------
// Chargement des données
// -------------------------------------------------------------------

function buildStatsPeriod() {
  const now = new Date();

  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    STATS_START_HOUR,
    0,
    0,
    0
  );
  const endToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    STATS_END_HOUR,
    0,
    0,
    0
  );

  let from;
  let until;

  if (now < startToday) {
    // avant 9h → on prend la plage de la veille
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    from = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      STATS_START_HOUR,
      0,
      0,
      0
    );
    until = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      STATS_END_HOUR,
      0,
      0,
      0
    );
  } else {
    from = startToday;
    until = now > endToday ? endToday : now;
  }

  return {
    from: from.toISOString(),
    until: until.toISOString(),
  };
}

async function loadData(api, { silent = false } = {}) {
  if (!silent) {
    setStatus('Chargement des agents…', 'info');
  }

  try {
    const { from, until } = buildStatsPeriod();

    const [agentsRaw, queuesRaw, usersRaw, queuesStatsRaw] = await Promise.all([
      api('/api/agentd/1.0/agents?recurse=true', { method: 'GET' }),
      api('/api/confd/1.1/queues?recurse=true', { method: 'GET' }),
      api('/api/confd/1.1/users?recurse=true', { method: 'GET' }),
      api(
        `/api/call-logd/1.0/queues/statistics?from=${encodeURIComponent(
          from
        )}&until=${encodeURIComponent(until)}`,
        { method: 'GET' }
      ).catch((e) => {
        console.warn(
          '[Superviseur] Impossible de charger les stats call-logd :',
          e
        );
        return null;
      }),
    ]);

    console.log('[Superviseur] Agents reçus', agentsRaw);
    console.log('[Superviseur] Queues reçues', queuesRaw);
    console.log('[Superviseur] Utilisateurs reçus', usersRaw);
    console.log('[Superviseur] Stats queues reçues', queuesStatsRaw);

    const { groups, queuesMeta } = groupAgentsByQueue(
      queuesRaw,
      usersRaw,
      agentsRaw
    );

    state.groups = groups;
    state.queuesMeta = queuesMeta;

        // Collecte des users pour charger leurs renvois inconditionnels
    const userUuidSet = new Set();
    for (const rows of groups.values()) {
      rows.forEach((agent) => {
        if (agent.userUuid) {
          userUuidSet.add(agent.userUuid);
        }
      });
    }

    // Renvois inconditionnels actuels (enabled + numéro)
state.userForwards = await loadUserForwards(api, userUuidSet);

// Stats files 9h–18h depuis call-logd
const queueStatsMap = new Map();

if (queuesStatsRaw) {
  const items = Array.isArray(queuesStatsRaw.items)
    ? queuesStatsRaw.items
    : Array.isArray(queuesStatsRaw)
    ? queuesStatsRaw
    : [];

  items.forEach((s) => {
    const qid = s.queue_id ?? s.queueId ?? s.id;
    if (!qid) return;

    queueStatsMap.set(qid, {
      total_calls:
        s.total_calls ?? s.received ?? s.calls ?? 0,
      answered_calls: s.answered_calls ?? s.answered ?? 0,
      missed_calls: s.missed_calls ?? s.missed ?? 0,
    });
  });
}

state.queueStats = queueStatsMap;

renderQueues(groups, api, queuesMeta);

    if (!silent) {
      setStatus('Agents chargés.', 'success');
    }
  } catch (err) {
    console.error('[Superviseur] Erreur loadData :', err);
    if (!silent) {
      setStatus(
        err.message ||
          'Erreur lors de la récupération de la liste des agents.',
        'error'
      );
      renderEmptyState('Erreur lors du chargement des agents.');
    }
  }
}

// -------------------------------------------------------------------
// WebSocket temps réel
// -------------------------------------------------------------------

function scheduleRealtimeReload(api) {
  if (state.realtimeReloadScheduled) return;
  state.realtimeReloadScheduled = true;

  setTimeout(async () => {
    state.realtimeReloadScheduled = false;
    try {
      await loadData(api, { silent: true });
    } catch (e) {
      console.error('[Superviseur] Erreur reload temps réel', e);
    }
  }, 1500);
}

function connectRealtime(baseUrl, token, api) {
  const wsUrl =
    baseUrl.replace(/^http/, 'ws') +
    '/api/websocketd/1.0/events?token=' +
    encodeURIComponent(token);

  console.log('[Superviseur] Connexion WebSocket', wsUrl);

  let ws;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('[Superviseur] Échec création WebSocket', err);
    return null;
  }

  ws.onopen = () => {
    console.log('[Superviseur] WebSocket ouvert');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[Superviseur] Event temps réel', data);

      scheduleRealtimeReload(api);
    } catch (err) {
      console.error('[Superviseur] Erreur parsing WS message', err);
    }
  };

ws.onclose = (ev) => {
  console.warn('[Superviseur] WebSocket fermé', ev.code, ev.reason);

  // 🔥 Token expiré → rechargement automatique
  if (ev.code === 4003) {
    console.error('[Superviseur] Token expiré → rechargement de la page...');
    setStatus('Session expirée — rechargement…', 'error');

    setTimeout(() => {
      window.location.reload();
    }, 800);

    return;
  }

  // Reconnexion automatique (déco réseau etc.)
  setTimeout(() => {
    if (state.api) {
      state.websocket = connectRealtime(baseUrl, token, api);
    }
  }, 1200);
};


  ws.onerror = (err) => {
    console.error('[Superviseur] WebSocket error', err);
  };

  return ws;
}

// -------------------------------------------------------------------
// Auto-refresh optimisé (cohabite bien avec WebSocket)
// -------------------------------------------------------------------

function startAutoRefresh(api) {

  if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    try {
      refreshBtn.classList.add('spin');
      setStatus("Rafraîchissement…", "info");
      await loadData(state.api, { silent: true });
      setStatus("Données mises à jour.", "success");
    } catch (err) {
      console.error("Erreur refresh manuel :", err);
      setStatus("Erreur refresh.", "error");
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spin'), 400);
    }
  });
}
  if (autoRefreshTimer) return;

  autoRefreshTimer = setInterval(async () => {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
      return;
    }

    if (isAutoRefreshing) return;
    isAutoRefreshing = true;

    try {
      await loadData(api, { silent: true });
    } catch (err) {
      console.error('[Superviseur] Erreur auto-refresh :', err);
    } finally {
      isAutoRefreshing = false;
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

// -------------------------------------------------------------------
// Initialisation du plugin (format E-UC commercial)
// -------------------------------------------------------------------

(async () => {
  const app = new App();

  try {
    setStatus('Initialisation du plugin…', 'info');

    await app.initialize();
    const context = app.getContext();
    console.log('[Superviseur] Contexte reçu :', context);

    const stackHost = context.user && context.user.host;
    const token = context.user && context.user.token;

    if (!stackHost || !token) {
      throw new Error('Host ou token manquant dans le contexte Wazo.');
    }

    const baseUrl = `https://${stackHost}`;
    console.log('[Superviseur] Stack host :', baseUrl);

    const api = createApiClient(baseUrl, token);
    state.api = api;
    state.baseUrl = baseUrl;
    state.token = token;

    // Premier chargement
    await loadData(api);

    // Auto-refresh léger en fond (toutes les 15s, skip si WebSocket OK)
    startAutoRefresh(api);

    // WebSocket pour les mises à jour temps réel
    state.websocket = connectRealtime(baseUrl, token, api);
  } catch (err) {
    console.error('[Superviseur] Erreur init :', err);
    setStatus(
      err.message || "Erreur durant l’initialisation du plugin.",
      'error'
    );
    renderEmptyState('Erreur lors du chargement des agents.');
  }
})();
