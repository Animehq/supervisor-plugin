import { App } from '@wazo/euc-plugins-sdk';

const app = new App();
await app.initialize();

const wda = app.wda;

// TODO: remplace ce UUID par le vrai group_uuid de ton groupe d'agents
const GROUP_UUID = "00000000-0000-0000-0000-000000000000";

loadAgents();

wda.on("agent-status-changed", () => {
  loadAgents();
});

async function loadAgents() {
  const tbody = document.getElementById("agents-body");
  tbody.innerHTML = "<tr><td colspan='4'>Chargement...</td></tr>";

  try {
    const agents = await wda.request("list-agents", {
      group_uuid: GROUP_UUID
    });

    tbody.innerHTML = "";

    agents.forEach(agent => {
      const row = document.createElement("tr");

      row.innerHTML = `
        <td>${agent.name}</td>
        <td>${agent.status}</td>
        <td>${agent.paused ? "Oui" : "Non"}</td>
        <td>
          <button onclick="pauseAgent('${agent.uuid}')">Pause</button>
          <button onclick="resumeAgent('${agent.uuid}')">Reprendre</button>
          <button onclick="logoutAgent('${agent.uuid}')">Déconnecter</button>
        </td>
      `;

      tbody.appendChild(row);
    });

  } catch (err) {
    tbody.innerHTML = "<tr><td colspan='4'>Erreur lors du chargement.</td></tr>";
    console.error(err);
  }
}

window.pauseAgent = async (uuid) => {
  await wda.request("pause-agent", { agent_uuid: uuid, reason: "supervisor_pause" });
  loadAgents();
};

window.resumeAgent = async (uuid) => {
  await wda.request("resume-agent", { agent_uuid: uuid });
  loadAgents();
};

window.logoutAgent = async (uuid) => {
  await wda.request("logout-agent", { agent_uuid: uuid });
  loadAgents();
};