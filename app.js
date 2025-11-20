// app.js
// ===================================================================
// Superviseur Agents Wazo – temps réel + actions + drag & drop
// ===================================================================

import { App } from 'https://cdn.jsdelivr.net/npm/@wazo/euc-plugins-sdk@latest/lib/esm/app.js';

// -------------------------------------------------------------------
// État global
// -------------------------------------------------------------------

const statusEl = document.getElementById('status');
const containerEl = document.getElementById('queues-container');

const state = {
  api: null,
  baseUrl: null,
  token: null,
  groups: new Map(),       // queueName -> rows[]
  queuesMeta: new Map(),   // queueName -> { id, raw }
  websocket: null,
  realtimeReloadScheduled: false,
};

// -------------------------------------------------------------------
// Helpers UI
// -------------------------------------------------------------------

function setStatus(message, type = 'info') {
  if (!statusEl) {
    console.warn('[Superviseur] Élément #status introuvable');
    return;
  }
  statusEl.textContent = message || '';
  statusEl.className = 'status';
  statusEl.classList.add(`status--${type}`);
}

function clearContainer() {
  if (containerEl) {
    containerEl.innerHTML = '';
  } else {
    console.warn('[Superviseur] Élément #queues-container introuvable');
  }
}

function renderEmptyState(message) {
  clearContainer();
  if (!containerEl) return;
  const div = document.createElement('div');
  div.className = 'empty-state text-slate-500 text-sm';
  div.textContent = message;
  containerEl.appendChild(div);
}

function createActionButton(label, variant = 'secondary') {
  const baseClasses =
    'btn btn--sm inline-flex items-center gap-1 rounded-md text-xs font-medium px-2.5 py-1 transition';
  let variantClasses =
    'btn--secondary border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';

  if (variant === 'primary') {
    variantClasses =
      'btn--primary bg-blue-600 text-white hover:bg-blue-700 border border-blue-600';
  } else if (variant === 'danger') {
    variantClasses =
      'btn--danger bg-rose-600 text-white hover:bg-rose-700 border border-rose-600';
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${baseClasses} ${variantClasses}`;
  btn.textContent = label;
  return btn;
}

// Style spécifique pour le bouton Login/Logout
function setLoginButtonStyle(btn, isLogged) {
  const baseClasses =
    'btn btn--sm inline-flex items-center gap-1 rounded-md text-xs font-medium px-2.5 py-1 transition';

  const variantClasses = isLogged
    ? 'btn--danger bg-rose-600 text-white hover:bg-rose-700 border border-rose-600'
    : 'btn--primary bg-blue-600 text-white hover:bg-blue-700 border border-blue-600';

  const extra = isLogged ? 'btn-logout' : 'btn-login';

  btn.className = `${baseClasses} ${variantClasses} ${extra}`;
}

// -------------------------------------------------------------------
// Client API générique basé sur host + token
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

  const groups = new Map();     // queueName -> rows[]
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
    return { text: 'Déconnecté', css: 'pill--offline bg-slate-100 text-slate-500' };
  }
  if (agent.paused) {
    return { text: 'En pause', css: 'pill--paused bg-amber-100 text-amber-700' };
  }
  return { text: 'Connecté', css: 'pill--online bg-emerald-100 text-emerald-700' };
}

function getPauseInfo(agent) {
  if (!agent.logged) {
    return { text: '—', css: 'pill--pause-no bg-slate-50 text-slate-400' };
  }
  if (agent.paused) {
    return { text: 'Oui', css: 'pill--pause-yes bg-amber-100 text-amber-700' };
  }
  return { text: 'Non', css: 'pill--pause-no bg-emerald-50 text-emerald-600' };
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
    waiting: '—', // à câbler sur calld/queue stats si tu veux aller plus loin
    inCall: '—',
    sla: '—',
  };
}

// -------------------------------------------------------------------
// Drag & Drop – déplacement d’un agent entre files
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

  containerEl.className =
    'queues-container flex flex-col gap-4 xl:grid xl:grid-cols-2 2xl:grid-cols-3';

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
    const queueId = queueMeta.id || null;
    const stats = computeQueueStats(rows);

    const section = document.createElement('section');
    section.className =
      'queue-card bg-white rounded-2xl shadow-[0_18px_35px_rgba(15,23,42,0.07)] border border-slate-200/60 p-4 flex flex-col';
    section.dataset.queueId = queueId || '';

    const header = document.createElement('header');
    header.className =
      'queue-card__header flex items-center justify-between gap-3 pb-2 border-b border-slate-200 mb-3';

    const title = document.createElement('h2');
    title.textContent = queueName;
    title.className = 'text-sm font-semibold text-slate-900 flex items-center gap-2';

    const meta = document.createElement('div');
    meta.className = 'queue-card__meta flex items-center gap-2 text-[11px] text-slate-600';

    const badgeAgents = document.createElement('span');
    badgeAgents.className =
      'badge badge--count bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-2 py-0.5';
    badgeAgents.textContent = `${stats.logged}/${stats.totalAgents} connectés`;

    const badgePaused = document.createElement('span');
    badgePaused.className =
      'badge bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5';
    badgePaused.textContent = `${stats.paused} en pause`;

    const badgeOffline = document.createElement('span');
    badgeOffline.className =
      'badge bg-slate-50 text-slate-500 border border-slate-200 rounded-full px-2 py-0.5';
    badgeOffline.textContent = `${stats.offline} off`;

    meta.appendChild(badgeAgents);
    meta.appendChild(badgePaused);
    meta.appendChild(badgeOffline);

    header.appendChild(title);
    header.appendChild(meta);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'queue-card__body overflow-x-auto';

    const table = document.createElement('table');
    table.className = 'agents-table w-full border-collapse text-xs';
    table.dataset.queueId = queueId || '';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr class="bg-slate-50">
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500">NOM</th>
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500">EXTENSION</th>
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500">ÉTAT</th>
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500">PAUSE</th>
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500">SUPERVISION</th>
        <th class="px-2 py-1 text-left text-[11px] font-semibold text-slate-500 col-actions">ACTIONS</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // Drag & drop – cible
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

      // DnD – source
      tr.dataset.agentId = agent.id || '';
      tr.dataset.queueId = agent.queueId || '';

      if (agent.id && agent.queueId) {
        tr.draggable = true;
        tr.classList.add('cursor-move', 'hover:bg-slate-50');

        tr.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData(
            'application/json',
            JSON.stringify({
              agentId: agent.id,
              fromQueueId: agent.queueId,
            })
          );
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

      // -------------------------------------------------------------------
      // SUPERVISION (Join / Spy / Whisper) – hooks à câbler sur calld
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // BOUTON PAUSE / REPRENDRE
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // BOUTON LOGIN / LOGOUT (avec résolution context via confd)
      // -------------------------------------------------------------------
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
          if (!agent.logged) {
            agent.paused = false;
          }

          const newStatus = getStatusInfo(agent);
          const newPause = getPauseInfo(agent);
          statusTd.innerHTML = `<span class="pill ${newStatus.css}">${newStatus.text}</span>`;
          pauseTd.innerHTML = `<span class="pill ${newPause.css}">${newPause.text}</span>`;

          pauseBtn.disabled = !agent.logged;
          loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
          setLoginButtonStyle(loginBtn, agent.logged);
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
// WebSocket temps réel (agentd / events bus)
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
  }, 2000);
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
