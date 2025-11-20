// app.js
// ===================================================================
// Superviseur Agents – affichage par files d’attente + actions
// ===================================================================

import { App } from 'https://cdn.jsdelivr.net/npm/@wazo/euc-plugins-sdk@latest/lib/esm/app.js';

// -------------------------------------------------------------------
// Références DOM
// -------------------------------------------------------------------

const statusEl = document.getElementById('status');
const containerEl = document.getElementById('queues-container');

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
  div.className = 'empty-state';
  div.textContent = message;
  containerEl.appendChild(div);
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

    // Si on envoie un body (JSON), on le sérialise et on ajoute le Content-Type
    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts = { ...opts, body: JSON.stringify(opts.body) };
    }

    console.log('[Superviseur] Appel API', opts.method || 'GET', url);

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
// Helpers de normalisation / mapping
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

// queues → regroupement agents par file d’attente
function groupAgentsByQueue(queuesRaw, usersRaw, agentsRaw) {
  const queues = normalizeCollection(queuesRaw);
  const usersByUuid = buildUsersByUuidMap(usersRaw);
  const { byExt, byId, byUuid } = buildAgentsMaps(agentsRaw);

  const groups = new Map();

  const ensureGroup = (label) => {
    if (!groups.has(label)) groups.set(label, []);
    return groups.get(label);
  };

  queues.forEach((queue) => {
    const queueLabel =
      queue.display_name || queue.label || queue.name || 'File d’attente';
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

          // On essaie de retrouver le user correspondant à l’extension pour le nom
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

      // Fallback par numéro brut
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
        name,
        logged: agentInfo?.logged ?? false,
        paused: agentInfo?.paused ?? false,
      };

      qGroup.push(row);
    });
  });

  console.log('[Superviseur] Groupes construits', groups);
  return groups;
}

// -------------------------------------------------------------------
// Helpers UI (statuts, boutons…)
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

function createActionButton(label, variant = 'secondary') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn btn--${variant} btn--sm`;
  btn.textContent = label;
  return btn;
}

// -------------------------------------------------------------------
// Rendu des files + actions
// -------------------------------------------------------------------

function renderQueues(groups, api) {
  clearContainer();
  if (!containerEl) return;

  if (!groups.size) {
    renderEmptyState('Aucun agent trouvé.');
    return;
  }

  // Ordre voulu :
  //  1. "Support IT"
  //  2. Les autres files triées alpha
  const SUPPORT_IT_PATTERN = /support\s*it/i;

  const orderedKeys = Array.from(groups.keys())
    // on élimine éventuellement "Sans file d'attente"
    .filter((name) => name !== "Sans file d'attente")
    .sort((a, b) => {
      const score = (name) => (SUPPORT_IT_PATTERN.test(name) ? 0 : 1);
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b, 'fr');
    });

  orderedKeys.forEach((queueName) => {
    // Tri alphabétique des agents par nom, puis extension
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

    const section = document.createElement('section');
    section.className = 'queue-card';

    const header = document.createElement('header');
    header.className = 'queue-card__header';
    const title = document.createElement('h2');
    title.textContent = queueName;
    header.appendChild(title);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'queue-card__body';

    const table = document.createElement('table');
    table.className = 'agents-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>NOM</th>
        <th>EXTENSION</th>
        <th>ÉTAT</th>
        <th>PAUSE</th>
        <th class="col-actions">ACTIONS</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

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
        <td class="col-actions"></td>
      `;

      const actionsCell = tr.querySelector('.col-actions');
      const statusTd = tr.querySelector('.col-status');
      const pauseTd = tr.querySelector('.col-pause');

      // Si pas d'id agent (pas associé), on affiche les actions désactivées
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

      // Bouton Pause / Reprendre
      const pauseBtn = createActionButton(
        agent.paused ? 'Reprendre' : 'Pause',
        'secondary'
      );
      pauseBtn.disabled = !agent.logged;

      pauseBtn.addEventListener('click', async () => {
        try {
          pauseBtn.disabled = true;

          const path = agent.paused
            ? `/api/agentd/1.0/agents/${agent.id}/resume`
            : `/api/agentd/1.0/agents/${agent.id}/pause`;

          console.log('[Superviseur] PAUSE/RESUME', path, agent);
          await api(path, { method: 'POST' });

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

      // Bouton Login / Logout
      const loginBtn = createActionButton(
        agent.logged ? 'Logout' : 'Login',
        agent.logged ? 'danger' : 'primary'
      );
      loginBtn.classList.add(agent.logged ? 'btn-logout' : 'btn-login');

      loginBtn.addEventListener('click', async () => {
        try {
          loginBtn.disabled = true;

          const path = agent.logged
            ? `/api/agentd/1.0/agents/${agent.id}/logout`
            : `/api/agentd/1.0/agents/${agent.id}/login`;

          console.log('[Superviseur] LOGIN/LOGOUT', path, agent);
          await api(path, { method: 'POST' });

          agent.logged = !agent.logged;
          if (!agent.logged) agent.paused = false;

          const newStatus = getStatusInfo(agent);
          const newPause = getPauseInfo(agent);
          statusTd.innerHTML = `<span class="pill ${newStatus.css}">${newStatus.text}</span>`;
          pauseTd.innerHTML = `<span class="pill ${newPause.css}">${newPause.text}</span>`;

          pauseBtn.disabled = !agent.logged;
          loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
          loginBtn.classList.toggle('btn-logout', agent.logged);
          loginBtn.classList.toggle('btn-login', !agent.logged);
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

    const groups = groupAgentsByQueue(queuesRaw, usersRaw, agentsRaw);
    renderQueues(groups, api);

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
    await loadData(api);
  } catch (err) {
    console.error('[Superviseur] Erreur init :', err);
    setStatus(
      err.message || "Erreur durant l’initialisation du plugin.",
      'error'
    );
    renderEmptyState('Erreur lors du chargement des agents.');
  }
})();
