// app.js
// ===================================================================
// Superviseur Agents – affichage par files d’attente + actions + temps réel
// ===================================================================

import { App } from 'https://cdn.jsdelivr.net/npm/@wazo/euc-plugins-sdk@latest/lib/esm/app.js';

// -------------------------------------------------------------------
// Références DOM & état global
// -------------------------------------------------------------------

const statusEl = document.getElementById('status');
const containerEl = document.getElementById('queues-container');
const compactToggleEl = document.getElementById('compact-toggle');
const themeToggleEl = document.getElementById('theme-toggle');

const state = {
  api: null,
  baseUrl: null,
  token: null,
  groups: new Map(),
  queuesMeta: new Map(),
  websocket: null,
  realtimeReloadScheduled: false,
};

const uiState = {
  compact: true, // compact actif par défaut
  dark: true,    // dark actif par défaut
};

function syncCompactUI() {
  const isCompact = uiState.compact;
  document.body.classList.toggle('is-compact', isCompact);

  if (compactToggleEl) {
    compactToggleEl.classList.toggle('toggle--active', isCompact);
    const label = compactToggleEl.querySelector('.toggle-label');
    if (label) {
      // On affiche l’action disponible (comme sur ton screen)
      label.textContent = isCompact ? 'Mode normal' : 'Mode compact';
    }
  }
}

function syncThemeUI() {
  const isDark = uiState.dark;
  document.body.classList.toggle('is-dark', isDark);

  if (themeToggleEl) {
    themeToggleEl.classList.toggle('toggle--active', isDark);
    const icon = themeToggleEl.querySelector('.toggle-icon');
    const label = themeToggleEl.querySelector('.toggle-label');

    if (icon) icon.textContent = isDark ? '☀️' : '🌙';
    if (label) {
      // Là aussi on affiche l’action : passer en clair / en sombre
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
    // pas de warning, on sort juste
    return;
  }
  statusEl.textContent = message || '';
  statusEl.className = 'status';
  statusEl.classList.add(`status--${type}`);
}

function clearContainer() {
  if (!containerEl) {
    // pas de warning
    return;
  }
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

// Style spécifique pour le bouton Login/Logout
function setLoginButtonStyle(btn, isLogged) {
  btn.className = 'btn btn--sm ' + (isLogged ? 'btn--danger' : 'btn--primary');
}



// -------------------------------------------------------------------
// Client API Wazo générique
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

      if (res.status === 401 || res.status === 403) {
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

  // Hue stable (0–360°)
  const hue = Math.abs(hash) % 360;

  // Couleurs pro (saturation/brightness modérés)
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

// users → map uuid -> { name, extension }
function buildUsersByUuidMap(usersRaw) {
  const users = normalizeCollection(usersRaw);
  const map = new Map();

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

    const key = user.uuid || user.id;
    if (key) {
      map.set(key, {
        name: displayName,
        extension,
      });
    }
  });

  console.log('[Superviseur] Map usersByUuid', map);
  return map;
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
  const usersByUuid = buildUsersByUuidMap(usersRaw);
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
            for (const [, uInfo] of usersByUuid) {
              if (
                uInfo.extension &&
                String(uInfo.extension) === String(extension)
              ) {
                name = uInfo.name;
                break;
              }
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

function getPauseInfo(agent) {
  if (!agent.logged) {
    return { text: '—', css: 'pill--pause-no' };
  }
  if (agent.paused) {
    return { text: 'Oui', css: 'pill--pause-yes' };
  }
  return { text: 'Non', css: 'pill--pause-no' };
}

function computeQueueStats(rows) {
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
    waiting: 0,
    inCall: 0,
    sla: '—',
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

  const orderedKeys = Array.from(groups.keys())
    .filter((name) => name !== "Sans file d'attente")
    .sort((a, b) => {
      const score = (name) => (SUPPORT_IT_PATTERN.test(name) ? 0 : 1);
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b, 'fr');
    });

  orderedKeys.forEach((queueName) => {
    const rows = [...(groups.get(queueName) || [])].sort((a, b) => {
      const nameA = (a.name || '').toLocaleLowerCase('fr-FR');
      const nameB = (b.name || '').toLocaleLowerCase('fr-FR');

      if (nameA === nameB) {
        const extA = a.extension || '';
        const extB = b.extension || '';
        return extA.localeCompare(extB, 'fr', { numeric: true });
      }

      return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
    });

    const queueMeta = queuesMeta.get(queueName) || {};
    let queueId = queueMeta.id || null;
    let stats = computeQueueStats(rows);

const section = document.createElement('section');
section.className = 'queue-card';

// Couleur personnalisée par file
const color = queueColorFromName(queueName);
section.style.borderLeft = `4px solid ${color}`;

// Option : halo léger autour de la carte en dark mode
if (document.body.classList.contains('is-dark')) {
  section.style.boxShadow = `0 0 0 1px ${color}22, var(--shadow-card)`;
}

if (SUPPORT_IT_PATTERN.test(queueName)) {
  section.classList.add('queue-card--priority');
}

section.dataset.queueId = queueId || '';

    const header = document.createElement('header');
    header.className = 'queue-card__header';

    const title = document.createElement('h2');
    title.textContent = queueName;

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

// Recalcule les stats à partir de `rows` et met à jour les badges
const updateHeaderStats = () => {
  stats = computeQueueStats(rows);
  badgeAgents.textContent = `${stats.logged}/${stats.totalAgents} connectés`;
  badgePaused.textContent = `${stats.paused} en pause`;
  badgeOffline.textContent = `${stats.offline} off`;
  badgeCalls.textContent = `Attente: ${stats.waiting} · En cours: ${stats.inCall} · SLA: ${stats.sla}`;
};

// Petite animation visuelle quand la file est mise à jour
const flashUpdating = () => {
  section.classList.add('queue-card--updating');
  setTimeout(() => section.classList.remove('queue-card--updating'), 300);
};

// Initialisation des badges à partir de l’état courant
updateHeaderStats();


    meta.appendChild(badgeAgents);
    meta.appendChild(badgePaused);
    meta.appendChild(badgeOffline);
    meta.appendChild(badgeCalls);

    header.appendChild(title);
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
        <th>PAUSE</th>
        <th>SUPERVISION</th>
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

    rows.forEach((agent) => {
      const tr = document.createElement('tr');

      const statusInfo = getStatusInfo(agent);
      const pauseInfo = getPauseInfo(agent);

      tr.innerHTML = `
        <td>${agent.name}</td>
        <td>${agent.extension || '—'}</td>
        <td class="col-status">
          <span class="pill ${statusInfo.css}">${statusInfo.text}</span>
        </td>
        <td class="col-pause">
          <span class="pill ${pauseInfo.css}">${pauseInfo.text}</span>
        </td>
        <td class="col-supervision"></td>
        <td class="col-actions"></td>
      `;

      const statusTd = tr.querySelector('.col-status');
      const pauseTd = tr.querySelector('.col-pause');
      const supervisionCell = tr.querySelector('.col-supervision');
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

      // Si pas d'id agent (pas associé), actions désactivées
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

      // SUPERVISION (Join / Spy / Whisper) – hooks à câbler sur calld
      const joinBtn = createActionButton('Join', 'secondary');
      const spyBtn = createActionButton('Spy', 'secondary');
      const whisperBtn = createActionButton('Whisper', 'secondary');

      joinBtn.addEventListener('click', () => {
        console.warn('[Superviseur] TODO join() à câbler sur calld pour', agent);
        alert("Join : à câbler sur l'API calld avec le call_id de l'agent.");
      });

      spyBtn.addEventListener('click', () => {
        console.warn('[Superviseur] TODO spy() à câbler sur calld pour', agent);
        alert("Spy : à câbler sur l'API calld pour écouter l'appel.");
      });

      whisperBtn.addEventListener('click', () => {
        console.warn('[Superviseur] TODO whisper() à câbler sur calld pour', agent);
        alert("Whisper : à câbler sur l'API calld pour chuchoter.");
      });

      supervisionCell.appendChild(joinBtn);
      supervisionCell.appendChild(spyBtn);
      supervisionCell.appendChild(whisperBtn);

      // BOUTON PAUSE / REPRENDRE (by-number)
      const pauseBtn = createActionButton(
        agent.paused ? 'Reprendre' : 'Pause',
        'secondary'
      );
      pauseBtn.disabled = !agent.logged;

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

          const newStatus = getStatusInfo(agent);
          const newPause = getPauseInfo(agent);
          statusTd.innerHTML = `<span class="pill ${newStatus.css}">${newStatus.text}</span>`;
          pauseTd.innerHTML = `<span class="pill ${newPause.css}">${newPause.text}</span>`;

          pauseBtn.textContent = agent.paused ? 'Reprendre' : 'Pause';
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

      // BOUTON LOGIN / LOGOUT (by-id + context depuis confd)
      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
      setLoginButtonStyle(loginBtn, agent.logged);

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
          // Mise à jour visuelle du bouton Pause
if (!agent.logged) {
  agent.paused = false; // sécurité
  pauseBtn.textContent = "Pause";
  pauseBtn.classList.remove("btn--pause-active");
  pauseBtn.classList.add("btn--pause-disabled");
} else {
  pauseBtn.classList.remove("btn--pause-disabled");
  if (agent.paused) {
    pauseBtn.classList.add("btn--pause-active");
    pauseBtn.textContent = "Reprendre";
  } else {
    pauseBtn.classList.remove("btn--pause-active");
    pauseBtn.textContent = "Pause";
  }
}


          const newStatus = getStatusInfo(agent);
const newPause = getPauseInfo(agent);
statusTd.innerHTML = `<span class="pill ${newStatus.css}">${newStatus.text}</span>`;
pauseTd.innerHTML = `<span class="pill ${newPause.css}">${newPause.text}</span>`;

pauseBtn.disabled = !agent.logged;
pauseBtn.textContent = agent.paused ? 'Reprendre' : 'Pause';
loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
setLoginButtonStyle(loginBtn, agent.logged);

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
    containerEl.appendChild(section);
  });
}

// -------------------------------------------------------------------
// Chargement des données
// -------------------------------------------------------------------

async function loadData(api) {
  setStatus('Chargement des agents…', 'info');

  try {
    const [agentsRaw, queuesRaw, usersRaw] = await Promise.all([
      api('/api/agentd/1.0/agents?recurse=true', { method: 'GET' }),
      api('/api/confd/1.1/queues?recurse=true', { method: 'GET' }),
      api('/api/confd/1.1/users?recurse=true', { method: 'GET' }),
    ]);

    console.log('[Superviseur] Agents reçus', agentsRaw);
    console.log('[Superviseur] Queues reçues', queuesRaw);
    console.log('[Superviseur] Utilisateurs reçus', usersRaw);

    const { groups, queuesMeta } = groupAgentsByQueue(
      queuesRaw,
      usersRaw,
      agentsRaw
    );

    state.groups = groups;
    state.queuesMeta = queuesMeta;

    renderQueues(groups, api, queuesMeta);

    setStatus('Agents chargés.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur loadData :', err);
    setStatus(
      err.message || 'Erreur lors de la récupération de la liste des agents.',
      'error'
    );
    renderEmptyState('Erreur lors du chargement des agents.');
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
      await loadData(api);
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

      const topic = data.name || data.event || '';
      if (
        topic.includes('agentd') ||
        topic.includes('queue') ||
        topic.includes('call_center')
      ) {
        scheduleRealtimeReload(api);
      }
    } catch (err) {
      console.error('[Superviseur] Erreur parsing WS message', err);
    }
  };

  ws.onclose = (ev) => {
    console.warn('[Superviseur] WebSocket fermé', ev.code, ev.reason);
    setTimeout(() => {
      if (state.api) {
        state.websocket = connectRealtime(baseUrl, token, api);
      }
    }, 5000);
  };

  ws.onerror = (err) => {
    console.error('[Superviseur] WebSocket error', err);
  };

  return ws;
}

// -------------------------------------------------------------------
// Initialisation du plugin
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

    await loadData(api);

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
