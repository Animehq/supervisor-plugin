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
  userAvailability: new Map(), // présence chatd
  userSessions: new Map(),    // connecté / non connecté (auth)
  userDnd: new Map(),         // service DND (confd)
  usersByUuid: new Map(),
usersByExt: new Map(),
directoryByNumber: new Map(),
  directoryCache: new Map(),    // num normalisé -> nom (lookup dird)
  dirdProfile: null,            // profil dird à utiliser (ex: "default")
  websocket: null,
  realtimeReloadScheduled: false,
  // Nouvel état pour les appels
  callsByUser: new Map(),   // userUuid -> info d’appel
  callDurationTimer: null,  // interval pour la durée en temps réel
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
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // pas grave si ce n'est pas du JSON
      }

      // 🧊 Cas particulier : user inconnu OU 404 générique sur /auth/.../sessions
      const isUserSessions404 =
        res.status === 404 &&
        path.startsWith('/api/auth/0.1/users/') &&
        path.endsWith('/sessions');

      if (isUserSessions404) {
        console.warn(
          '[Superviseur] Utilisateur inconnu pour les sessions auth, marqué comme non connecté :',
          path,
          json || text || '(pas de payload)'
        );
        // On fait comme s'il n'avait aucune session
        return { items: [] };
      }

      console.error('[Superviseur] Erreur API', res.status, url, text);

      // 🔐 Sécurité token expiré côté API REST
      if (res.status === 401 || res.status === 403) {
        const lower = (text || '').toLowerCase();

        if (lower.includes('expired') || lower.includes('token')) {
          setStatus('Session expirée — rechargement…', 'error');
          setTimeout(() => {
            window.location.reload();
          }, 800);
          return;
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
  state.usersByUuid = usersByUuid;
  state.usersByExt = usersByExt;


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

function buildUserAvailabilityFromPresences(presencesRaw) {
  const map = new Map();
  if (!presencesRaw) return map;

  let items = [];

  // Plusieurs formes possibles suivant la version :
  if (Array.isArray(presencesRaw.items)) {
    items = presencesRaw.items;
  } else if (Array.isArray(presencesRaw.presences)) {
    items = presencesRaw.presences;
  } else if (Array.isArray(presencesRaw)) {
    items = presencesRaw;
  }

  items.forEach((item) => {
    const uuid =
      item.user_uuid || item.userUuid || item.uuid || item.id || null;
    if (!uuid) return;

    // On essaie de récupérer un champ "agrégé"
    // ⚠️ On privilégie d'abord les états riches (state / status / flags)
    let value =
      item.state ||
      item.status ||
      null;

    // Certains payloads exposent des booléens dnd / invisible
    if (!value && typeof item.dnd === 'boolean') {
      value = item.dnd ? 'dnd' : 'available';
    }
    if (!value && typeof item.invisible === 'boolean') {
      if (item.invisible) {
        value = 'invisible';
      }
    }

    // Si toujours rien, on retombe sur availability / presence.*
    if (!value) {
      value =
        item.availability ||
        (item.presence &&
          (item.presence.state ||
            item.presence.status ||
            item.presence.availability)) ||
        // fallback : on garde l’objet entier, traité plus tard par getAvailabilityPill
        item;
    }

    map.set(uuid, value);
  });

  console.log('[Superviseur] userAvailability (chatd)', map);
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

   // ======================================================
  // GROUPE VIRTUEL "Hors call center"
  //   -> tous les users qui ont une extension,
  //      même s'ils sont déjà membres d'une ou plusieurs files
  // ======================================================
  const PARKING_LABEL = 'Hors call center';

  const parkingRows = [];

  usersByUuid.forEach((user, uuid) => {
    // pas d’extension -> inutile pour la supervision
    if (!user.extension) return;

    const agentInfo =
      byUuid.get(uuid) ||
      byExt.get(String(user.extension)) ||
      null;

    parkingRows.push({
      id: agentInfo?.id ?? null,
      extension: user.extension,
      number: agentInfo?.number || null,
      name: user.name,
      logged: agentInfo?.logged ?? false,
      paused: agentInfo?.paused ?? false,
      queueId: null,             // ⬅️ pas de queue réelle
      queueLabel: PARKING_LABEL, // ⬅️ nom affiché
      userUuid: uuid,
    });
  });

  if (parkingRows.length) {
    groups.set(PARKING_LABEL, parkingRows);
    // PAS de queuesMeta.set -> pas de queue_id réel, c'est voulu
  }




  console.log('[Superviseur] Groupes construits', groups, queuesMeta);
  return { groups, queuesMeta };
}

async function buildUserSessionsForParking(groups, api) {
  const PARKING_LABEL = 'Hors call center';
  const map = new Map();

  const parkingRows = groups.get(PARKING_LABEL) || [];
  if (!parkingRows.length) {
    return map;
  }

  // Uniquement les userUuid uniques de la file Hors ACD
  const uniqueUuids = Array.from(
    new Set(
      parkingRows
        .map((row) => row.userUuid)
        .filter(Boolean)
    )
  );

  if (!uniqueUuids.length) {
    return map;
  }

  const tasks = uniqueUuids.map(async (uuid) => {
    let isConnected = false;

    try {
      const res = await api(
        `/api/auth/0.1/users/${encodeURIComponent(uuid)}/sessions`,
        { method: 'GET' }
      );

      let sessions = [];

      if (!res) {
        // null / undefined → pas de session
        sessions = [];
      } else if (Array.isArray(res)) {
        // réponse = tableau brut
        sessions = res;
      } else if (Array.isArray(res.items)) {
        // format courant { items: [...] }
        sessions = res.items;
      } else if (Array.isArray(res.sessions)) {
        // autre format possible { sessions: [...] }
        sessions = res.sessions;
      } else {
        // format inconnu → on considère aucune session
        sessions = [];
      }

      isConnected = sessions.length > 0;
    } catch (e) {
      console.warn(
        '[Superviseur] Impossible de charger les sessions auth pour',
        uuid,
        e
      );
      isConnected = false;
    }

    map.set(uuid, isConnected);
  });

  await Promise.all(tasks);

  console.log('[Superviseur] userSessions (auth)', map);
  return map;
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

function getAvailabilityPill(rawAvailability) {
  if (rawAvailability == null) {
    return { text: 'Indisponible', css: 'pill--offline' };
  }

  const v = String(rawAvailability).toLowerCase().trim();

  // 🟢 Disponible
  if (v === 'available' || v === 'online') {
    return { text: 'Disponible', css: 'pill--available' };
  }

  // 📞 En appel / OnCall
  if (
    v === 'oncall' ||
    v === 'on_call' ||
    v === 'on-the-phone' ||
    v === 'on_the_phone'
  ) {
    return { text: 'En appel', css: 'pill--busy' };
  }

  // 🟠 Occupé (away / busy)
  if (v === 'away' || v === 'busy') {
    return { text: 'Occupé', css: 'pill--busy' };
  }

  // 🔴 Indisponible / Hors ligne
  if (v === 'unavailable' || v === 'offline' || v.includes('unavailab')) {
    return { text: 'Indisponible', css: 'pill--unavailable' };
  }

  // 👻 Invisible
  if (v.includes('invisible')) {
    return { text: 'Invisible', css: 'pill--invisible' };
  }

  // Défaut = indisponible
  return { text: 'Indisponible', css: 'pill--offline' };
}

function getDndPill(userUuid) {
  if (!userUuid) {
    return { text: '—', css: 'pill--offline' };
  }

  const map = state.userDnd || new Map();
  const enabled = map.get(userUuid) === true;

  if (enabled) {
    return { text: 'DND', css: 'pill--dnd' };
  }

  // DND désactivé : on peut afficher "Off" ou "—"
  return { text: 'Off', css: 'pill--available' };
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
  if (!agentId) return;

  // Drop dans la même file ACD -> rien à faire
  if (fromQueueId && toQueueId && fromQueueId === toQueueId) {
    return;
  }

  const ops = [];
  const isDropToParking = !toQueueId; // toQueueId === null => "Hors call center"

  try {
    if (isDropToParking) {
      // 🧹 Drop vers "Hors call center" :
      // on enlève seulement l'agent de l’ancienne file
      if (fromQueueId) {
        setStatus('Retrait de l’agent de la file…', 'info');
        ops.push(
          api(`/api/agentd/1.0/agents/by-id/${agentId}/remove`, {
            method: 'POST',
            body: { queue_id: fromQueueId },
          })
        );
      }
    } else {
      // ➕ Drop vers une file ACD :
      // on AJOUTE l’agent dans la nouvelle file,
      // sans le retirer des autres -> multi-files
      setStatus('Ajout de l’agent dans la file…', 'info');
      ops.push(
        api(`/api/agentd/1.0/agents/by-id/${agentId}/add`, {
          method: 'POST',
          body: { queue_id: toQueueId },
        })
      );
      // Pas de remove ici : l’agent peut rester dans les files précédentes
    }

    if (!ops.length) return;

    await Promise.all(ops);
    await loadData(api);
    setStatus('Files mises à jour.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur moveAgentBetweenQueues', err);
    alert(
      'Erreur lors de la mise à jour de l’agent dans les files.\n' +
        (err.message || '')
    );
    setStatus('Erreur lors de la mise à jour des files.', 'error');
  }
}

function findAgentInStateById(agentId) {
  if (!state.groups || agentId == null) return null;

  for (const agents of state.groups.values()) {
    const found = agents.find((a) => String(a.id) === String(agentId));
    if (found) return found;
  }
  return null;
}



// Synchronise toutes les lignes DOM d'un même agent (cas : agent dans plusieurs files)
function syncAgentDom(agent) {
  if (!agent || !containerEl) return;

  // 1) on essaie par agent-id
  let selector = null;
  if (agent.id != null) {
    selector = `tr[data-agent-id="${agent.id}"]`;
  } else if (agent.userUuid) {
    // 2) fallback par userUuid (cas Hors call center / multi-files)
    selector = `tr[data-user-uuid="${agent.userUuid}"]`;
  } else {
    return;
  }

  const rows = containerEl.querySelectorAll(selector);
  if (!rows.length) return;

  rows.forEach((row) => {
    const statusTd = row.querySelector('.col-status');
    const pauseBtn = row.querySelector('.agent-pause-btn');
    const loginBtn = row.querySelector('.agent-login-btn');

    let statusInfo;
    const card = row.closest('.queue-card');
    const isParkingRow =
      card && card.classList.contains('queue-card--parking');

    if (isParkingRow && agent.userUuid) {
      const sessionsMap     = state.userSessions     || new Map();
      const dndMap          = state.userDnd          || new Map();
      const availabilityMap = state.userAvailability || new Map();
      const callsByUser     = state.callsByUser      || new Map();

      const hasSession  = sessionsMap.get(agent.userUuid) === true;
      const dndEnabled  = dndMap.get(agent.userUuid) === true;
      const hasPresence = availabilityMap.has(agent.userUuid);
      const hasCall     = callsByUser.has(agent.userUuid); // 👈 user en appel ?

      if (!hasSession) {
        statusInfo = { text: 'Non connecté', css: 'pill--offline' };
      } else if (dndEnabled) {
        statusInfo = { text: 'Ne pas déranger', css: 'pill--dnd' };
      } else if (hasCall) {
        // 👇 nouveau statut En appel / OnCall
        statusInfo = { text: 'En appel', css: 'pill--oncall' };
      } else if (hasPresence) {
        const raw = availabilityMap.get(agent.userUuid);
        statusInfo = getAvailabilityPill(raw);
      } else {
        statusInfo = { text: 'Disponible', css: 'pill--available' };
      }
    } else {
      statusInfo = getStatusInfo(agent);
    }


    if (statusTd && statusInfo) {
      statusTd.innerHTML = `<span class="pill ${statusInfo.css}">${statusInfo.text}</span>`;
    }

    // ⚠️ on NE TOUCHE PLUS à .col-dnd ici (sinon on efface le bouton)

    if (pauseBtn) {
      pauseBtn.disabled = !agent.logged;
      pauseBtn.textContent = agent.paused ? 'Reprendre' : 'Pause';
      pauseBtn.classList.toggle(
        'btn--pause-active',
        agent.logged && agent.paused
      );
      pauseBtn.classList.toggle('btn--pause-disabled', !agent.logged);
    }

    if (loginBtn) {
      loginBtn.textContent = agent.logged ? 'Logout' : 'Login';
      setLoginButtonStyle(loginBtn, agent.logged);
    }

    const supervisionButtons = row.querySelectorAll('.btn-supervision');
    supervisionButtons.forEach((btn) => {
      btn.disabled = !agent.logged;
    });
  });
}

function buildCallChipHtml(callInfo) {
  // Aucun appel en cours
  if (!callInfo) {
    return `
      <div class="call-cell">
        <div class="call-chip call-chip--none">
          <span class="call-chip__number">—</span>
          <span class="call-chip__duration"></span>
        </div>
      </div>
    `;
  }

  // Avec appel en cours
  const label = callInfo.number || 'Appel en cours';
  const dirIcon =
    callInfo.direction === 'inbound'
      ? `<span class="call-chip__dir inbound">⬅️</span>`
      : `<span class="call-chip__dir outbound">➡️</span>`;

  return `
    <div class="call-cell">
      <div class="call-chip call-chip--active" data-call-start="${callInfo.startedAt}">
        ${dirIcon}
        <span class="call-chip__number">${label}</span>
        <span class="call-chip__duration">00:00</span>
      </div>
    </div>
  `;
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

function syncAllForwardControlsForUser(userUuid, forwardEnabled, forwardNumber) {
  if (!userUuid || !containerEl) return;

  const cells = containerEl.querySelectorAll(
    `tr[data-user-uuid="${userUuid}"] .col-transfer`
  );

  cells.forEach((td) => {
    const input = td.querySelector('.transfer-input');
    const btn = td.querySelector('.transfer-control .btn');

    if (input) {
      input.value = forwardNumber || '';
    }

    if (btn) {
      btn.classList.remove('btn--primary', 'btn--danger');

      if (forwardEnabled) {
        // Transfert actif → OFF rouge
        btn.textContent = 'OFF';
        btn.classList.add('btn--danger');
      } else {
        // Transfert inactif → ON vert
        btn.textContent = 'ON';
        btn.classList.add('btn--primary');
      }
    }
  });
}


function syncAllDndButtonsForUser(userUuid, dndEnabled) {
  // Pas d’UUID ou pas de conteneur → rien à faire
  if (!userUuid || !containerEl) return;

  // On récupère tous les boutons NPD (DND) de ce user,
  // dans toutes les files d’attente
  const buttons = containerEl.querySelectorAll(
    `tr[data-user-uuid="${userUuid}"] .col-dnd button`
  );

  buttons.forEach((btn) => {
    btn.classList.remove('btn--primary', 'btn--danger');

    if (dndEnabled) {
      // DND actif → bouton OFF rouge
      btn.textContent = 'OFF';
      btn.classList.add('btn--danger');
      btn.setAttribute('aria-pressed', 'true');
    } else {
      // DND inactif → bouton ON vert
      btn.textContent = 'ON';
      btn.classList.add('btn--primary');
      btn.setAttribute('aria-pressed', 'false');
    }
  });
}



function buildDndToggleCell(agent, api) {
  const td = document.createElement('td');
  td.className = 'col-dnd';

  const btn = createActionButton('', 'primary');

const getUserUuidFromRow = () => {
  const row = btn.closest('tr');

  if (row && row.dataset.userUuid) {
    return row.dataset.userUuid;
  }

  // Cas où le bouton n'est pas encore dans un <tr>
  return agent.userUuid || null;
};


  let currentUuid = getUserUuidFromRow();
  if (!currentUuid) {
    td.textContent = '—';
    return td;
  }

  const isEnabledInState = (uuid) =>
    !!(state.userDnd && state.userDnd.get(uuid) === true);

  let dndEnabled = isEnabledInState(currentUuid);

  const syncDndUi = () => {
    btn.classList.remove('btn--primary', 'btn--danger');
    if (dndEnabled) {
      // DND actif -> OFF rouge
      btn.textContent = 'OFF';
      btn.classList.add('btn--danger');
    } else {
      // DND inactif -> ON vert
      btn.textContent = 'ON';
      btn.classList.add('btn--primary');
    }
  };

  syncDndUi();

  btn.addEventListener('click', async () => {
  const userUuid = getUserUuidFromRow();
  if (!userUuid) {
    console.warn('[Superviseur] Pas de userUuid pour DND', agent);
    return;
  }

    const targetState = !dndEnabled;

  try {
    setStatus(
      `${targetState ? 'Activation' : 'Désactivation'} du DND pour ${agent.name}…`,
      'info'
    );

    await api(
      `/api/confd/1.1/users/${encodeURIComponent(userUuid)}/services/dnd`,
      {
        method: 'PUT',
        body: { enabled: targetState },
      }
    );

    if (!state.userDnd) state.userDnd = new Map();
    state.userDnd.set(userUuid, targetState);

    dndEnabled = targetState;
    syncDndUi();

    // 🔁 met à jour tous les boutons NPD de ce user
    syncAllDndButtonsForUser(userUuid, targetState);

    // 🔄 met à jour sa disponibilité dans toutes les files
    const realAgent = [...state.groups.values()]
  .flat()
  .find(a => a.id === agent.id || a.userUuid === userUuid);

if (realAgent) {
  // On met à jour uniquement DND
  syncAgentDom(realAgent);
}

    setStatus('DND mis à jour.', 'success');
  } catch (err) {
    console.error('[Superviseur] Erreur DND', err);
    setStatus('Erreur lors de la mise à jour du DND.', 'error');
  }

});


  td.appendChild(btn);
  return td;
}




async function loadUserDnd(api, userUuidSet) {
  const result = new Map();

  const tasks = Array.from(userUuidSet || []).map(async (uuid) => {
    if (!uuid) {
      return;
    }

    try {
      const res = await api(
        `/api/confd/1.1/users/${encodeURIComponent(
          uuid
        )}/services/dnd`,
        { method: 'GET' }
      );

      // suivant la version, le flag peut s’appeler enabled / dnd / active
      const enabled = !!(
        res &&
        (res.enabled === true ||
          res.dnd === true ||
          res.active === true)
      );

      result.set(uuid, enabled);
    } catch (e) {
      console.warn('[Superviseur] DND introuvable pour', uuid, e);
      result.set(uuid, false);
    }
  });

  await Promise.all(tasks);

  console.log('[Superviseur] userDnd', result);
  return result;
}

// Rafraîchit le DND pour UN seul utilisateur, puis met à jour l'UI
async function refreshUserDndForUser(api, userUuid) {
  if (!userUuid) return;

  try {
    // On réutilise loadUserDnd mais avec un seul UUID
    const map = await loadUserDnd(api, new Set([userUuid]));
    const enabled = map.get(userUuid) === true;

    if (!state.userDnd) {
      state.userDnd = new Map();
    }
    state.userDnd.set(userUuid, enabled);

    // 1) Met à jour tous les boutons NPD (DND) de ce user
    syncAllDndButtonsForUser(userUuid, enabled);

    // 2) Met à jour les pills / statuts des lignes liées à ce user
    const allAgents = [...state.groups.values()].flat();
    const relatedAgents = allAgents.filter(
      (a) => a.userUuid === userUuid
    );

    relatedAgents.forEach((agent) => {
      syncAgentDom(agent);
    });
  } catch (e) {
    console.warn(
      '[Superviseur] Impossible de rafraîchir le DND via WS pour',
      userUuid,
      e
    );
  }
}

// Rafraîchit le renvoi inconditionnel pour UN user, puis met à jour l'UI
async function refreshUserForwardForUser(api, userUuid) {
  if (!userUuid) return;

  try {
    // On réutilise loadUserForwards mais avec un seul UUID
    const forwardsMap = await loadUserForwards(api, new Set([userUuid]));
    const info = forwardsMap.get(userUuid) || { enabled: false, destination: '' };

    if (!state.userForwards) {
      state.userForwards = new Map();
    }
    state.userForwards.set(userUuid, {
      enabled: !!info.enabled,
      destination: info.destination || '',
    });

    // 1) Met à jour tous les champs/boutons de transfert pour ce user
    syncAllForwardControlsForUser(
      userUuid,
      !!info.enabled,
      info.destination || ''
    );

    // 2) (optionnel) on refresh les lignes liées si ton statut dépend du forward
    const allAgents = [...state.groups.values()].flat();
    const relatedAgents = allAgents.filter(a => a.userUuid === userUuid);
    relatedAgents.forEach(agent => syncAgentDom(agent));
  } catch (e) {
    console.warn(
      '[Superviseur] Impossible de rafraîchir le renvoi via WS pour',
      userUuid,
      e
    );
  }
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

function startCallDurationTicker() {
  if (state.callDurationTimer) {
    clearInterval(state.callDurationTimer);
  }

  const update = () => {
    const now = Date.now();
    document.querySelectorAll('.call-chip[data-call-start]').forEach((chip) => {
      const start = Number(chip.dataset.callStart);
      if (!start) return;
            let secs = Math.floor((now - start) / 1000);
      if (secs < 0) secs = 0;

      // 💡 Hack UX : dès qu'on commence à compter, on force au moins 1 seconde
      // pour éviter l'effet "bloqué à 00:00" pendant 1 seconde.
      if (secs === 0) secs = 1;
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');

      const durEl = chip.querySelector('.call-chip__duration');
      if (durEl) {
        durEl.textContent = `${mm}:${ss}`;
      }
    });
  };

  update();
  state.callDurationTimer = setInterval(update, 1000);
}

async function buildCallsByUserMap_EUC(callsRaw, api) {
  const map = new Map();
  if (!callsRaw) return map;

  const list = normalizeCollection(callsRaw);
  const previousMap = state.callsByUser || new Map();

  for (const call of list) {
    const data = call.data || call || {};

    // --- Quel utilisateur (agent) est lié à cet appel ? ---
    const userUuid =
      data.user_uuid ||
      (Array.isArray(data.users) && data.users[0] && data.users[0].uuid) ||
      data.source_user_uuid ||
      data.owner_uuid ||
      null;

    if (!userUuid) continue;

    // --- On ne garde que les appels DÉCROCHÉS ---
    // On essaye plusieurs indices possibles de "answered"
    const status = (data.status || '').toLowerCase();
    const isAnswered =
      !!data.answered_at ||
      status === 'up' ||
      status === 'answered' ||
      status === 'in-progress';

    if (!isAnswered) {
      // Appel encore en sonnerie ou déjà terminé → pas de chrono
      continue;
    }

    // --- Extension de l’agent (pour exclure son propre numéro) ---
    const userInfo = state.usersByUuid && state.usersByUuid.get(userUuid);
    const userExt = userInfo && userInfo.extension
      ? String(userInfo.extension)
      : null;

    // --- Quel numéro afficher ? (toujours l’AUTRE partie) ---
    let candidates;

    if (data.direction === 'outbound') {
      // Sortant : numéro appelé
      candidates = [
        data.remote_callee_id_number,
        data.callee_id_number,
        data.other_party_number,
        data.dialed_extension,
        data.caller_id_number,
      ];
    } else if (data.direction === 'inbound') {
      // Entrant : numéro de l’appelant externe
      candidates = [
        data.remote_caller_id_number,
        data.caller_id_number,
        data.other_party_number,
        data.display_caller_name,
      ];
    } else {
      // Interne / inconnu : on essaye de deviner
      candidates = [
        data.other_party_number,
        data.remote_caller_id_number,
        data.remote_callee_id_number,
        data.caller_id_number,
        data.callee_id_number,
        data.callee_exten,
        data.dialed_extension,
      ];
    }

    let number = null;
    for (const cand of candidates) {
      if (!cand) continue;
      const s = String(cand).trim();
      if (!s) continue;
      // On saute l’extension de l’agent
      if (userExt && s === userExt) continue;
      number = s;
      break;
    }

    const displayNumber = resolveNumberLabel(number || '');

    // --- Date de début pour le timer ---
    // On se cale sur started_at (moment où l'appel est établi côté Wazo).
    // Si l'horloge du serveur est en avance, on "clampe" à maintenant.
    let startedAtMs = null;
    const now = Date.now();

    if (data.started_at) {
      const ts = Date.parse(data.started_at);
      if (Number.isFinite(ts) && ts <= now) {
        // started_at valide et pas dans le futur
        startedAtMs = ts;
      }
    }

    // Si le serveur nous donne un started_at dans le futur
    // ou rien du tout, on démarre le chrono au moment où
    // l'appel apparaît dans le plugin.
    if (!Number.isFinite(startedAtMs)) {
      startedAtMs = now;
    }

    map.set(userUuid, {
      number: displayNumber,
      rawNumber: number,
      direction: data.direction === 'inbound' ? 'inbound' : 'outbound',
      startedAt: startedAtMs,
    });
  }

  console.log('[Superviseur] callsByUser EUC construit', map);
  return map;
}

function normalizePhone(num) {
  if (!num) return '';
  let s = String(num).trim();

  // On enlève espaces, tirets, points, parenthèses
  s = s.replace(/[\s.\-\(\)]/g, '');

  // Cas FR : +33 / 0033 -> 0X…
  if (s.startsWith('+33') && s.length > 3) {
    s = '0' + s.slice(3);
  } else if (s.startsWith('0033') && s.length > 4) {
    s = '0' + s.slice(4);
  } else if (s.length === 11 && s.startsWith('336')) {
    // Cas parfois stocké en 336XXXXXXXX → 06XXXXXXXX
    s = '0' + s.slice(2);
  }

  return s;
}


function resolveNumberLabel(rawNumber) {
  if (!rawNumber) return '';
  const raw = String(rawNumber);
  const num = normalizePhone(raw);

  // 1) Cache d'annuaire dird (lookup à la volée)
  if (state.directoryCache && state.directoryCache.has(num)) {
    const name = state.directoryCache.get(num);
    if (name) {
      return raw + ' – ' + name;
    }
  }

  // 2) Annuaire interne : extension -> nom utilisateur
  if (state.usersByExt && state.usersByExt.has(num)) {
    const user = state.usersByExt.get(num);
    if (user && user.name) {
      return raw + ' – ' + user.name;
    }
  }

  // Sinon, on affiche juste le numéro
  return raw;
}



async function loadAllDirectoriesEntries(api) {
  // Ancien mécanisme basé sur confd désactivé (CORS / E-UC).
  // On utilise maintenant dird avec lookup à la volée.
  console.log('[Superviseur] Annuaire confd désactivé, utilisation de dird en lookup.');
  return new Map();
}


async function ensureDirdProfile() {
  // Profil déjà déterminé
  if (state.dirdProfile !== null) {
    return state.dirdProfile; // peut être null si on n'a rien trouvé
  }

  if (!state.api) return null;

  try {
    const res = await state.api('/api/dird/0.1/profiles?recurse=true', {
      method: 'GET',
    });

    const items = (res && res.items) || [];
    if (!items.length) {
      console.warn('[Superviseur] Aucun profil dird disponible');
      state.dirdProfile = null;
      return null;
    }

    // On privilégie "default" si présent, sinon le premier
    const defaultProfile = items.find((p) => p.name === 'default');
    const chosen = defaultProfile || items[0];

    state.dirdProfile = chosen && chosen.name ? chosen.name : null;
    console.log('[Superviseur] Profil dird sélectionné :', state.dirdProfile);

    return state.dirdProfile;
  } catch (e) {
    console.warn('[Superviseur] Impossible de charger les profils dird', e);
    state.dirdProfile = null;
    return null;
  }
}

async function enrichCallCellWithDirectory(td, rawNumber) {
  if (!rawNumber || !state.api) return;

  const raw = String(rawNumber);
  const norm = normalizePhone(raw);
  if (!norm) return;

  // Initialise le cache si besoin
  if (!state.directoryCache) {
    state.directoryCache = new Map();
  }

  // Déjà en cache ?
  if (state.directoryCache.has(norm)) {
    const cached = state.directoryCache.get(norm);
    if (!cached) return; // on a déjà tenté → pas trouvé

    const span = td.querySelector('.call-chip__number');
    if (span) {
      span.textContent = `${raw} – ${cached}`;
    }
    return;
  }

  const profile = await ensureDirdProfile();
  if (!profile) return;

  let res;
  try {
    res = await state.api(
      `/api/dird/0.1/directories/lookup/${encodeURIComponent(
        profile
      )}?term=${encodeURIComponent(norm)}`,
      { method: 'GET' }
    );
  } catch (e) {
    console.warn('[Superviseur] Lookup dird échoué pour', norm, e);
    return;
  }

  const items = (res && res.items) || [];
  if (!items.length) {
    // On mémorise "rien trouvé" pour éviter de spammer l'API
    state.directoryCache.set(norm, null);
    return;
  }

  const contact = items[0];

  const name =
    contact.name ||
    contact.display_name ||
    `${contact.firstname || ''} ${contact.lastname || ''}`.trim();

  if (!name) {
    state.directoryCache.set(norm, null);
    return;
  }

  // On met à jour le cache
  state.directoryCache.set(norm, name);

  // Et on met à jour la pastille si elle est encore là
  const span = td.querySelector('.call-chip__number');
  if (span) {
    span.textContent = `${raw} – ${name}`;
  }
}



function renderQueues(groups, api, queuesMeta) {
  clearContainer();
  if (!containerEl) return;

  if (!groups.size) {
    renderEmptyState('Aucun agent trouvé.');
    return;
  }

  const SUPPORT_IT_PATTERN = /support\s*it/i;
  const SAV_PATTERN = /^sav\b/i;
  const PARKING_LABEL = 'Hors call center';

  const allNames = Array.from(groups.keys());

  // File Support IT (prioritaire)
  const supportName = allNames.find((n) => SUPPORT_IT_PATTERN.test(n));

  // Notre file virtuelle "Hors call center"
  const parkingName = groups.has(PARKING_LABEL) ? PARKING_LABEL : null;

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
    const isParking = queueName === PARKING_LABEL;

    if (isSupport) {
      section.classList.add('queue-card--priority');
    }

    if (isParking) {
  section.classList.add('queue-card--parking');
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

if (!isParking) {
  meta.appendChild(badgeAgents);
  meta.appendChild(badgePaused);
  meta.appendChild(badgeOffline);
  meta.appendChild(badgeCalls);
}

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

if (isParking) {
  // Hors call center : Nom / Extension / Disponibilité / Transfert
  thead.innerHTML = `
    <tr>
      <th>NOM</th>
      <th>EXTENSION</th>
      <th>DISPONIBILITÉ</th>
      <th>TRANSFERT</th>
      <th>NPD</th>
    </tr>
  `;
} else {
  // Files ACD classiques
  thead.innerHTML = `
    <tr>
      <th>NOM</th>
      <th>EXTENSION</th>
      <th>ÉTAT</th>
      <th>APPEL EN COURS</th>
      <th>SUPERVISION</th>
      <th>TRANSFERT</th>
      <th>NPD</th>
      <th class="col-actions">ACTIONS</th>
    </tr>
  `;
}

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

      try {
        const data = ev.dataTransfer.getData('application/json');
        if (!data) return;
        const parsed = JSON.parse(data);
        const agentId = parsed.agentId;
        const fromQueueId = parsed.fromQueueId;

         if (!agentId || fromQueueId === queueIdTarget) return;

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

            const callsByUser = state.callsByUser || new Map();

      let statusInfo;

      // File "Hors call center" → sessions + DND + présence + appels en cours
      if (isParking && agent.userUuid) {
        const sessionsMap     = state.userSessions     || new Map();
        const dndMap          = state.userDnd          || new Map();
        const availabilityMap = state.userAvailability || new Map();
        const callsByUser     = state.callsByUser      || new Map();

        const hasSession  = sessionsMap.get(agent.userUuid) === true;
        const dndEnabled  = dndMap.get(agent.userUuid) === true;
        const hasPresence = availabilityMap.has(agent.userUuid);
        const hasCall     = callsByUser.has(agent.userUuid); // 👈 user en appel ?

        if (!hasSession) {
          statusInfo = { text: 'Non connecté', css: 'pill--offline' };
        } else if (dndEnabled) {
          statusInfo = { text: 'Ne pas déranger', css: 'pill--dnd' };
        } else if (hasCall) {
          // 👇 nouveau statut En appel / OnCall
          statusInfo = { text: 'En appel', css: 'pill--oncall' };
        } else if (hasPresence) {
          const raw = availabilityMap.get(agent.userUuid);
          // Ici, raw peut valoir "available", "away", "busy", "invisible", etc.
          statusInfo = getAvailabilityPill(raw);
        } else {
          statusInfo = { text: 'Disponible', css: 'pill--available' };
        }
      } else {
        // Files ACD classiques → status agent (logged / paused / disconnected)
        statusInfo = getStatusInfo(agent);
      }


      // 💬 Appel en cours (map userUuid -> callInfo)
      const callInfo =
        agent.userUuid && callsByUser.has(agent.userUuid)
          ? callsByUser.get(agent.userUuid)
          : null;

      const callCellHtml = buildCallChipHtml(callInfo);

      let supervisionCell = null;
      let transferCell = null;
      let actionsCell = null;

      if (isParking) {
        // Hors call center : Nom / Extension / Disponibilité / Transfert / DND
        tr.innerHTML = `
          <td>${agent.name}</td>
          <td>${agent.extension || '—'}</td>
          <td class="col-status">
            <span class="pill ${statusInfo.css}">${statusInfo.text}</span>
          </td>
          <td class="col-transfer"></td>
          <td class="col-dnd"></td>
        `;
        transferCell = tr.querySelector('.col-transfer');
      } else {
        // Files ACD complètes
        tr.innerHTML = `
          <td>${agent.name}</td>
          <td>${agent.extension || '—'}</td>
          <td class="col-status">
            <span class="pill ${statusInfo.css}">${statusInfo.text}</span>
          </td>
          <td class="col-call">${callCellHtml}</td>
          <td class="col-supervision"></td>
          <td class="col-transfer"></td>
          <td class="col-dnd"></td>
          <td class="col-actions"></td>
        `;

        supervisionCell = tr.querySelector('.col-supervision');
        transferCell = tr.querySelector('.col-transfer');
        actionsCell = tr.querySelector('.col-actions');
      }




tr.dataset.agentId = agent.id || '';
tr.dataset.queueId = agent.queueId || '';

if (agent.userUuid) {
  tr.dataset.userUuid = agent.userUuid;
}


      if (agent.id) {
        tr.draggable = true;

        tr.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.effectAllowed = 'move';
          tr.classList.add('dragging');
          ev.dataTransfer.setData(
            'application/json',
            JSON.stringify({
              agentId: agent.id,
              fromQueueId: agent.queueId || null,  // ⬅️ null pour Hors call center
            })
          );
        });

        tr.addEventListener('dragend', () => {
          tr.classList.remove('dragging');
        });
      }

      // Si pas d'id agent → actions désactivées


// --- DND bouton ---
const dndCell = tr.querySelector('.col-dnd');

// DND bouton (même style que transfert)
if (dndCell) {
  const cell = buildDndToggleCell(agent, api);
  dndCell.replaceWith(cell);
}

if (!agent.id && !isParking && actionsCell && !actionsCell.hasChildNodes()) {
  const pauseBtn = createActionButton('Pause', 'secondary');
  const loginBtn = createActionButton('Login', 'primary');
  pauseBtn.disabled = true;
  loginBtn.disabled = true;
  actionsCell.appendChild(pauseBtn);
  actionsCell.appendChild(loginBtn);
}

// TRANSFERT MOBILE (renvoi inconditionnel, 1 seul bouton ON/OFF)
if (transferCell) {
  const wrapper = document.createElement('div');
  wrapper.className = 'transfer-control';

  const input = document.createElement('input');
  input.type = 'tel';
  input.placeholder = 'Portable…';
  input.className = 'transfer-input';

  const toggleBtn = createActionButton('ON', 'primary');

  const getUserUuidFromRow = () => {
    const row = toggleBtn.closest('tr');
    if (row && row.dataset.userUuid) {
      return row.dataset.userUuid;
    }
    // Fallback : userUuid porté par l’agent (Hors call center / ACD)
    return agent.userUuid || null;
  };

  const initialUuid = getUserUuidFromRow();

  // ❌ Pas de userUuid -> on ne peut pas gérer le forward
  if (!initialUuid) {
    transferCell.textContent = '—';
  } else {
    let forwardEnabled = false;
    let forwardNumber = '';

    if (state.userForwards && state.userForwards.has(initialUuid)) {
      const fw = state.userForwards.get(initialUuid);
      forwardEnabled = !!fw.enabled;
      forwardNumber = fw.destination || '';
    }

    const syncForwardUi = () => {
      input.value = forwardNumber || '';
      toggleBtn.classList.remove('btn--primary', 'btn--danger');

      if (forwardEnabled) {
        toggleBtn.textContent = 'OFF';
        toggleBtn.classList.add('btn--danger');
      } else {
        toggleBtn.textContent = 'ON';
        toggleBtn.classList.add('btn--primary');
      }
    };

    syncForwardUi();

    toggleBtn.addEventListener('click', async () => {
      const userUuid = getUserUuidFromRow();
      if (!userUuid) {
        console.warn('[Superviseur] Pas de userUuid pour le transfert', agent);
        return;
      }

      if (!forwardEnabled) {
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
          await setUserMobileForward(userUuid, num, api);
          forwardEnabled = true;
          forwardNumber = num;

          if (!state.userForwards) state.userForwards = new Map();
          state.userForwards.set(userUuid, {
            enabled: true,
            destination: num,
          });

          syncForwardUi();
          // si tu as déjà syncAllForwardControlsForUser, tu peux aussi appeler :
          // syncAllForwardControlsForUser(userUuid, forwardEnabled, forwardNumber);

          setStatus('Transfert activé.', 'success');
        } catch (err) {
          console.error('[Superviseur] Erreur transfert mobile ON', err);
          setStatus('Erreur transfert mobile.', 'error');
        }
      } else {
        try {
          setStatus(
            `Désactivation du transfert mobile pour ${agent.name}…`,
            'info'
          );
          await setUserMobileForward(userUuid, '', api);
          forwardEnabled = false;
          forwardNumber = '';

          if (!state.userForwards) state.userForwards = new Map();
          state.userForwards.set(userUuid, {
            enabled: false,
            destination: '',
          });

          syncForwardUi();
          // idem ici si tu veux propager :
          // syncAllForwardControlsForUser(userUuid, forwardEnabled, forwardNumber);

          setStatus('Transfert désactivé.', 'success');
        } catch (err) {
          console.error('[Superviseur] Erreur transfert mobile OFF', err);
          setStatus('Erreur transfert mobile.', 'error');
        }
      }
    });

    wrapper.appendChild(input);
    wrapper.appendChild(toggleBtn);
    transferCell.textContent = '';
    transferCell.appendChild(wrapper);
  }
} else if (transferCell) {
  transferCell.textContent = '—';
}



if (!isParking) {
      // SUPERVISION (Join / Spy / Whisper)
const joinBtn = createActionButton('Join', 'secondary');
const spyBtn = createActionButton('Spy', 'secondary');
const whisperBtn = createActionButton('Whisper', 'secondary');

// ➕ on marque ces 3 boutons comme boutons de supervision
[joinBtn, spyBtn, whisperBtn].forEach((btn) => {
  btn.disabled = !agent.logged;
  btn.classList.add('btn-supervision');
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

      // BOUTON PAUSE / REPRENDRE
      const pauseBtn = createActionButton(
        agent.paused ? 'Reprendre' : 'Pause',
        'secondary'
      );


      pauseBtn.disabled = !agent.logged;
      pauseBtn.classList.add('agent-pause-btn');

pauseBtn.classList.toggle(
  'btn--pause-active',
  agent.logged && agent.paused
);

      pauseBtn.addEventListener('click', async () => {
  const wasPaused = !!agent.paused;
  const newPaused = !wasPaused;

  // 🔸 Mise à jour immédiate de l’UI (rapide, sans attendre l’API)
  agent.paused = newPaused;
  syncAgentDom(agent);

  try {
    pauseBtn.disabled = true;

    const agentNumber = agent.number || agent.extension;
    if (!agentNumber) {
      throw new Error(
        `Numéro d'agent introuvable pour ${agent.name} (id=${agent.id}).`
      );
    }

    const basePath = `/api/agentd/1.0/agents/by-number/${agentNumber}`;
    const path = newPaused
      ? `${basePath}/pause`
      : `${basePath}/unpause`;

    const options = { method: 'POST' };
    if (newPaused) {
      options.body = { reason: 'plugin-superviseur' };
    }

    console.log('[Superviseur] PAUSE/UNPAUSE', path, options, agent);
    await api(path, options);

    updateHeaderStats();
    flashUpdating();
  } catch (err) {
    console.error('[Superviseur] Erreur pause/reprendre', err);
    alert(
      'Erreur lors du changement de pause de cet agent.\n' +
        (err.message || '')
    );

    // ⏪ En cas d’erreur, on revient à l’ancien état
    agent.paused = wasPaused;
    syncAgentDom(agent);
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
        const wasLogged = !!agent.logged;
        const newLogged = !wasLogged;

        // 🔸 Mise à jour immédiate de l’UI (comme pour Pause)
        agent.logged = newLogged;
        if (!newLogged) {
          // si on se délogue → plus en pause
          agent.paused = false;
        }
        syncAgentDom(agent);

        try {
          loginBtn.disabled = true;

          const basePath = `/api/agentd/1.0/agents/by-id/${agent.id}`;
          const path = newLogged
            ? `${basePath}/login`
            : `${basePath}/logoff`;

          const options = { method: 'POST' };

          if (newLogged) {
            // On se logue → il faut extension + context
            const { extension, context } = await resolveAgentLoginTarget(
              agent,
              api
            );
            options.body = { extension, context };
          }

          console.log('[Superviseur] LOGIN/LOGOFF', path, options, agent);
          await api(path, options);

          // API OK → juste maj stats + petit flash
          updateHeaderStats();
          flashUpdating();
        } catch (err) {
          console.error('[Superviseur] Erreur login/logout', err);
          alert(
            'Erreur lors du login/logout de cet agent.\n' +
              (err.message || '')
          );

          // ⏪ Rollback en cas d’erreur
          agent.logged = wasLogged;
          if (!agent.logged) {
            agent.paused = false;
          }
          syncAgentDom(agent);
        } finally {
          loginBtn.disabled = false;
        }
      });

      actionsCell.appendChild(pauseBtn);
      actionsCell.appendChild(loginBtn);

      
    }
  
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

  // -----------------------------------------------------------------
  // Disposition des cartes :
  // - toutes les files ACD à gauche (en colonne)
  // - "Hors call center" à droite (colonne distincte)
  // -----------------------------------------------------------------
if (parkingName) {
    // Layout 2 colonnes
    const layout = document.createElement('div');
    layout.className = 'queues-layout';

    // Colonne gauche : toutes les files ACD (Support IT, SAV, autres)
    const acdCol = document.createElement('div');
    acdCol.className = 'queues-col queues-col--acd';

    const acdNamesOrdered = [];
    if (supportName) acdNamesOrdered.push(supportName);
    acdNamesOrdered.push(...savNames.sort((a, b) => a.localeCompare(b, 'fr')));
    acdNamesOrdered.push(
      ...otherNames.sort((a, b) => a.localeCompare(b, 'fr'))
    );

    const seen = new Set();
    acdNamesOrdered.forEach((queueName) => {
      if (!queueName || seen.has(queueName)) return;
      seen.add(queueName);
      const rows = groups.get(queueName) || [];
      acdCol.appendChild(buildQueueCard(queueName, rows));
    });

    layout.appendChild(acdCol);

    // Colonne droite : "Hors call center"
    const parkingRows = groups.get(parkingName) || [];
    const parkingCol = document.createElement('div');
    parkingCol.className = 'queues-col queues-col--parking';
    parkingCol.appendChild(buildQueueCard(parkingName, parkingRows));

    layout.appendChild(parkingCol);

       containerEl.appendChild(layout);

    // 🔧 Harmoniser la hauteur :
    // on force la hauteur TOTALE de la carte "Hors call center"
    // à être égale à la hauteur de la colonne ACD
    requestAnimationFrame(() => {
      const acdHeight = acdCol.offsetHeight;
      const parkingCard = parkingCol.querySelector('.queue-card');
      const parkingBody = parkingCol.querySelector('.queue-card__body');

      if (!acdHeight || !parkingCard || !parkingBody) return;

      // "chrome" = header + bordures + padding de la carte
      const chrome = parkingCard.offsetHeight - parkingBody.offsetHeight;
      const targetBodyHeight = Math.max(0, acdHeight - chrome);

      parkingBody.style.height = targetBodyHeight + 'px';
      parkingBody.style.maxHeight = targetBodyHeight + 'px';
      parkingBody.style.overflowY = 'auto';
    });

  } else {
    // Pas de "Hors call center" -> layout classique

    // 1) Ligne Support IT seule
    if (supportName) {
      const row = document.createElement('div');
      row.className = 'queues-row';
      const supportRows = groups.get(supportName) || [];
      row.appendChild(buildQueueCard(supportName, supportRows));
      containerEl.appendChild(row);
    }

    // 2) Ligne SAV (toutes les SAV côte à côte)
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


  // Met à jour la durée des appels en temps réel
  startCallDurationTicker();
}

async function refreshCallsFromApi(api) {
  try {
const callsRaw = await api('/api/calld/1.0/calls');
const oldMap = state.callsByUser || new Map();
const newMap = await buildCallsByUserMap_EUC(callsRaw, api, oldMap);

    state.callsByUser = newMap;

    const affected = new Set();
    for (const k of oldMap.keys()) affected.add(k);
    for (const k of newMap.keys()) affected.add(k);

    affected.forEach((userUuid) => {
      refreshCallCellForUser(userUuid);  // ✅ seulement les lignes impactées
    });

    startCallDurationTicker();
  } catch (err) {
    console.error('[Superviseur] Erreur refresh calls depuis WS :', err);
  }
}


// Met à jour UNIQUEMENT la/les lignes d’un user pour la colonne "APPEL EN COURS"
function refreshCallCellForUser(userUuid) {
  if (!userUuid || !containerEl || !state.callsByUser) return;

  const callInfo = state.callsByUser.get(userUuid) || null;

  // Toutes les lignes de cet user (ACD + Hors call center)
  const rows = containerEl.querySelectorAll(
    `tr[data-user-uuid="${userUuid}"]`
  );
  if (!rows.length) return;

  const html = buildCallChipHtml(callInfo);

  rows.forEach((row) => {
    // 1) Met à jour la colonne "APPEL EN COURS"
    const td = row.querySelector('.col-call');   // 👉 il manquait CETTE LIGNE
    if (td) {
      td.innerHTML = html;

      // 🔍 Enrichir le label avec l'annuaire dird (Annuaire Adexgroup, etc.)
      if (callInfo && callInfo.rawNumber && typeof enrichCallCellWithDirectory === 'function') {
        // Appel asynchrone, on ne bloque pas le rendu
        enrichCallCellWithDirectory(td, callInfo.rawNumber);
      }
    }

    // 2) Recalcule le statut (DISPONIBILITÉ / ÉTAT) via syncAgentDom
    let agent = null;

    const agentId = row.dataset.agentId;
    if (agentId) {
      agent = findAgentInStateById(agentId);
    }

    if (!agent) {
      // fallback par userUuid (surtout utile pour Hors call center)
      agent = [...state.groups.values()]
        .flat()
        .find(a => a.userUuid === userUuid);
    }

    if (agent) {
      syncAgentDom(agent);
    }
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


const [
  agentsRaw,
  queuesRaw,
  usersRaw,
  queuesStatsRaw,
  callsRaw,
  presencesRaw,
] = await Promise.all([
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
  api('/api/calld/1.0/calls', { method: 'GET' }).catch((e) => {
    console.warn(
      '[Superviseur] Impossible de charger les appels en cours :',
      e
    );
    return null;
  }),
  // 🔥 Nouvelle requête : vraie présence utilisateur
  api('/api/chatd/1.0/users/presences?recurse=true', { method: 'GET' }).catch(
    (e) => {
      console.warn(
        '[Superviseur] Impossible de charger les présences (chatd) :',
        e
      );
      return null;
    }
  ),
]);

console.log('[Superviseur] Agents reçus', agentsRaw);
console.log('[Superviseur] Queues reçues', queuesRaw);
console.log('[Superviseur] Utilisateurs reçus', usersRaw);
console.log('[Superviseur] Stats queues reçues', queuesStatsRaw);
console.log('[Superviseur] Présences reçues', presencesRaw);

// 🟢 Présence (chatd) : available / away / unavailable / …
  state.userAvailability = buildUserAvailabilityFromPresences(presencesRaw);

  // Groupes / files / meta
  const { groups, queuesMeta } = groupAgentsByQueue(
    queuesRaw,
    usersRaw,
    agentsRaw
  );

  state.groups = groups;
  state.queuesMeta = queuesMeta;

  // Collecte des users pour DND + renvois inconditionnels
  const userUuidSet = new Set();
  for (const rows of groups.values()) {
    rows.forEach((agent) => {
      if (agent.userUuid) {
        userUuidSet.add(agent.userUuid);
      }
    });
  }


  // 🔎 Charger tous les annuaires (confd) une fois au chargement
  //state.directoryByNumber = await loadAllDirectoriesEntries(api);
  
  // Appels en cours → map userUuid -> { number, direction, startedAt }
  state.callsByUser = await buildCallsByUserMap_EUC(callsRaw, api);

  // Sessions (auth) – connecté / non connecté
  state.userSessions = await buildUserSessionsForParking(groups, api);

  // DND pour tous les users (confd)
  state.userDnd = await loadUserDnd(api, userUuidSet);

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

// -------------------------------------------------------------------
// Fallback WebSocket : neutralisé en mode ZERO POLLING
// -------------------------------------------------------------------
function scheduleRealtimeReload(api) {
  // En mode ultra-optimisé, on ne fait plus de reload global auto.
  // On garde juste un log pour debug.
  console.debug('[Superviseur] scheduleRealtimeReload ignoré (mode ZERO POLLING)');
}


function normalizeEventName(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')     // espaces → rien
    .replace(/-/g, '.')      // tirets → points
    .replace(/_/g, '.');     // underscore → points
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
    try {
      ws.send(JSON.stringify({ op: 'subscribe', data: { event_name: '*' } }));
      ws.send(JSON.stringify({ op: 'start' }));
    } catch (e) {
      console.error('[Superviseur] Erreur subscribe/start WS', e);
    }
  };

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    // Messages de contrôle
    if (data.op && typeof data.code === 'number') {
      console.log('[Superviseur] WS control :', data);
      return;
    }

    const evRaw =
      data.event_name ||
      data.event_type ||
      data.name ||
      data.type ||
      data.op;

    const ev = normalizeEventName(evRaw); // ex: "call_ended" → "call.ended"
    const payload = data.data || data;

    console.log('[Superviseur] WS event', evRaw, payload);

   // ======================================================
// 1) DND / Services utilisateur / Forward
// ======================================================
if (
  ev.includes('dnd') ||
  ev === 'user.services.updated' ||
  ev.includes('forward')
) {
  const p = payload || {};
  const userUuid =
    p.user_uuid || p.userUuid || p.uuid ||
    (p.user && (p.user.uuid || p.user.user_uuid)) ||
    null;

  if (!userUuid) return;

  // Si l’event parle explicitement de DND → on ne touche que DND
  if (ev.includes('dnd')) {
    await refreshUserDndForUser(api, userUuid);
  } else {
    // Event générique de services → on rafraîchit DND + Forward
    await Promise.all([
      refreshUserDndForUser(api, userUuid),
      refreshUserForwardForUser(api, userUuid),
    ]);
  }
  return;
}


    // ======================================================
    // 2) AGENT : login/logout
    // (agent.logged_in / agent.logged_out → normalisé en agent.logged.in / agent.logged.out)
    // ======================================================
    if (ev === 'agent.logged.in' || ev === 'agent.logged.out') {
      const p = payload || {};
      const agentId = p.agent_id ?? p.agent?.id ?? p.agent?.agent_id;
      const isLogged = ev === 'agent.logged.in';

      if (!agentId) return;

      const agent = findAgentInStateById(agentId);
      if (agent) {
        agent.logged = isLogged;
        if (!isLogged) {
          agent.paused = false; // délogué → plus en pause
        }
        syncAgentDom(agent);
        return;
      }

      // Si on ne trouve pas l'agent en mémoire, petit reload ciblé
      scheduleRealtimeReload(api);
      return;
    }

    // ======================================================
    // 3) AGENT STATUS UPDATE
    // ======================================================
    if (ev === 'agent.status.update') {
      const p = payload || {};
      const agentId = p.agent_id ?? p.agent?.id ?? p.agent?.agent_id;
      const status = (p.status || '').toLowerCase();

      if (!agentId) return;

      const agent = findAgentInStateById(agentId);
      if (agent) {
        if (status === 'logged_out') {
          agent.logged = false;
          agent.paused = false;
        } else if (status === 'logged_in') {
          agent.logged = true;
        }
        syncAgentDom(agent);
        return;
      }

      scheduleRealtimeReload(api);
      return;
    }

    // ======================================================
    // 4) AGENT PAUSE / UNPAUSE
    // ======================================================
    if (ev === 'queue.member.paused' || ev === 'agent.paused') {
      const p = payload || {};
      const agentId =
        p.agent_id ??
        p.member?.agent_id ??
        p.queue_member?.agent_id ??
        p.agent?.id ??
        p.agent?.agent_id;

      if (!agentId) return;

      const agent = findAgentInStateById(agentId);
      if (agent) {
        agent.paused = true;
        syncAgentDom(agent);
        return;
      }

      scheduleRealtimeReload(api);
      return;
    }

    if (ev === 'queue.member.unpaused' || ev === 'agent.unpaused') {
      const p = payload || {};
      const agentId =
        p.agent_id ??
        p.member?.agent_id ??
        p.queue_member?.agent_id ??
        p.agent?.id ??
        p.agent?.agent_id;

      if (!agentId) return;

      const agent = findAgentInStateById(agentId);
      if (agent) {
        agent.paused = false;
        syncAgentDom(agent);
        return;
      }

      scheduleRealtimeReload(api);
      return;
    }

    // ======================================================
    // 5) ÉVÉNEMENTS APPELS (créé / mis à jour / répondu / raccroché / log)
    //    → PAS de reload global : juste /calld/1.0/calls + update des cellules concernées
    // ======================================================
    if (
      ev === 'call.created' ||
      ev === 'call.updated' ||
      ev === 'call.answered' ||
      ev === 'call.ended' ||
      ev === 'call.hangup' ||
      ev === 'call.log.created' ||
      ev === 'call.log.user.created'
    ) {
      // Ici, refreshCallsFromApi(api) :
      //  - fait un GET /api/calld/1.0/calls
      //  - reconstruit callsByUser (Map)
      //  - compare avec l'ancien Map
      //  - met à jour UNIQUEMENT les cellules des users impactés
      await refreshCallsFromApi(api);
      return;
    }

// ======================================================
// X) Présence / disponibilité (chatd_presence_updated)
// ======================================================
if (
  evRaw === 'chatd_presence_updated' ||   // nom brut venant du WS
  ev === 'chatd.presence.updated'        // nom normalisé (avec les points)
) {
  const p = payload || {};
  const userUuid =
    p.user_uuid || p.userUuid || p.uuid || p.id || null;

  if (!userUuid) return;

  // On sépare bien "state" (available/away/...) et "status" (oncall, on_the_phone, etc.)
  const stateField =
    p.state ||
    p.availability ||
    (p.presence &&
      (p.presence.state || p.presence.availability)) ||
    null;

  const statusField =
    p.status ||
    (p.presence && p.presence.status) ||
    null;

  let value = null;

  // 1) Si le status indique explicitement un appel → on force "oncall"
  if (
    statusField &&
    /call|phone/i.test(String(statusField))
  ) {
    value = 'oncall';
  } else if (stateField) {
    // 2) Sinon on garde la state "classique"
    value = stateField;
  } else if (statusField) {
    // 3) À défaut on tombe sur status brut
    value = statusField;
  }

  // 4) Fallbacks DND / invisible si on n'a toujours rien
  if (!value && typeof p.dnd === 'boolean') {
    value = p.dnd ? 'dnd' : 'available';
  }
  if (!value && typeof p.invisible === 'boolean' && p.invisible) {
    value = 'invisible';
  }

  if (!state.userAvailability) {
    state.userAvailability = new Map();
  }
  state.userAvailability.set(userUuid, value);

  // On ne touche qu'aux agents liés à ce userUuid
  const allAgents = [...state.groups.values()].flat();
  const relatedAgents = allAgents.filter(a => a.userUuid === userUuid);
  relatedAgents.forEach(agent => syncAgentDom(agent));

  return;
}




    // ======================================================
    // 6) Tout le reste est ignoré (pas de reload auto)
    // ======================================================
    console.log('[Superviseur] WS ignoré', evRaw);
  };

  ws.onclose = (ev) => {
    console.warn('[Superviseur] WebSocket fermé', ev.code, ev.reason);

    // Token expiré
    if (ev.code === 4003) {
      setStatus('Session expirée — rechargement…', 'error');
      setTimeout(() => window.location.reload(), 800);
      return;
    }

    // Reconnexion auto
    setTimeout(() => {
      if (state.api) {
        state.websocket = connectRealtime(baseUrl, token, api);
      }
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('[Superviseur] WebSocket error', err);
  };

  return ws;
}



// -------------------------------------------------------------------
// Auto-refresh ultra-optimisé : ZERO POLLING
// -------------------------------------------------------------------
function startAutoRefresh(api) {
  // 🔁 Bouton refresh manuel uniquement
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';

    refreshBtn.addEventListener('click', async () => {
      try {
        refreshBtn.classList.add('spin');
        setStatus('Rafraîchissement…', 'info');

        // 🔄 reload global, mais UNIQUEMENT sur clic
        await loadData(state.api, { silent: true });

        setStatus('Données mises à jour.', 'success');
      } catch (err) {
        console.error('Erreur refresh manuel :', err);
        setStatus('Erreur refresh.', 'error');
      } finally {
        setTimeout(() => refreshBtn.classList.remove('spin'), 400);
      }
    });
  }

  // 🔇 On désactive complètement l’auto-refresh interval
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  // ❌ et SURTOUT : PAS de setInterval ici
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
