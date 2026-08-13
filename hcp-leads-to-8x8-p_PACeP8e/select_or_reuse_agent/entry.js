import { axios } from "@pipedream/platform";

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Count an agent's open tasks in the 8x8 internal CRM. Agents are expected to
// close tasks when handled, so Pending count reflects current workload.
async function countPendingTasks(agentId, $) {
  const xml = `
<WAPI>
  <TENANT>${escapeXml(process.env.EIGHTX8_CRM_TENANT)}</TENANT>
  <USERNAME>${escapeXml(process.env.EIGHTX8_CRM_USERNAME)}</USERNAME>
  <PASSWORD>${escapeXml(process.env.EIGHTX8_CRM_PASSWORD)}</PASSWORD>

  <COMMAND OBJECT="Task" ACTION="Get">
    <ASSIGNEDTO>${escapeXml(agentId)}</ASSIGNEDTO>
    <TASK_STATUS>Pending</TASK_STATUS>
  </COMMAND>
</WAPI>`.trim();

  const response = await axios($, {
    method: "POST",
    url: `${process.env.EIGHTX8_BASE_URL}/WAPI/wapi.php`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: new URLSearchParams({ xml_query: xml }).toString(),
  });

  const responseText =
    typeof response === "string" ? response : JSON.stringify(response);

  if (!responseText.includes('STATUS="0"')) {
    throw new Error(`Task query failed: ${responseText.slice(0, 300)}`);
  }

  return (responseText.match(/<TASKNUM>/g) || []).length;
}

// Alert the ops channel when an agent's open-task count exceeds this.
const OVERLOAD_THRESHOLD = 5;

// At most one overload alert per agent per hour (the step runs on every lead).
const OVERLOAD_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export default defineComponent({
  props: {
    unassignedStore: {
      type: "data_store",
    },
    slackMap: {
      type: "data_store",
    },
  },
  async run({ steps, $ }) {
    const mapping = steps.get_mapping?.$return_value || null;

    // If this lead was already assigned before, keep the same agent.
    if (mapping?.assignedAgentId) {
      return {
        mode: "reused_existing_assignment",
        selectedAgentId: mapping.assignedAgentId,
        selectedAgentName: mapping.assignedAgentName || "",
        groupId: mapping.agentGroupId || steps.get_agents_by_group.$return_value.groupId,
        totalAgentsInGroup: steps.get_agents_by_group.$return_value.agentList?.length || 0,
      };
    }

    const agentList =
      steps.get_agents_by_group?.$return_value?.agentList || [];

    if (agentList.length === 0) {
      throw new Error("No agents found from get_agents_by_group.");
    }

    // 8x8 agent-status 4 = WAIT_TRANSACT (available, waiting for work).
    const availableAgents = agentList.filter((agent) => agent.status === 4);

    // No one available: park the lead for later processing and stop the
    // workflow instead of assigning to an unavailable agent.
    if (availableAgents.length === 0) {
      const lead = steps.normalize_lead.$return_value;
      const storeKey = `no_agents:${lead.hcpLeadId}`;

      await this.unassignedStore.set(storeKey, {
        storedAt: new Date().toISOString(),
        event: steps.trigger.event?.event || "",
        groupId: steps.get_agents_by_group.$return_value.groupId,
        totalAgentsInGroup: agentList.length,
        lead,
      });

      $.flow.exit(
        `No available agents in group ${steps.get_agents_by_group.$return_value.groupId}. Lead ${lead.hcpLeadId} parked under "${storeKey}".`
      );
      return;
    }

    // Least-loaded assignment: count each available agent's Pending tasks and
    // assign to whoever has the fewest (ties broken randomly).
    const counts = await Promise.all(
      availableAgents.map(async (agent) => {
        try {
          const pendingTasks = await countPendingTasks(agent.agentId, $);
          return { agent, pendingTasks };
        } catch (err) {
          console.log(
            `Pending-task count failed for ${agent.agentId} (${agent.name}): ${err.message}`
          );
          return { agent, pendingTasks: null };
        }
      })
    );

    const usable = counts.filter((c) => c.pendingTasks !== null);

    // Workload alert: post to the ops channel when an agent is carrying more
    // than OVERLOAD_THRESHOLD open tasks, throttled per agent. Fail-open -
    // alerting problems never block assignment.
    const overloaded = usable.filter(
      (c) => c.pendingTasks > OVERLOAD_THRESHOLD
    );

    const slackToken = process.env.SLACK_BOT_TOKEN;
    const alertChannel = process.env.SLACK_ALERT_CHANNEL_ID;

    if (overloaded.length > 0 && (!slackToken || !alertChannel)) {
      console.log(
        `OVERLOAD ALERT SKIPPED (missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL_ID): ${overloaded
          .map((c) => `${c.agent.name}=${c.pendingTasks}`)
          .join(", ")}`
      );
    } else {
      for (const { agent, pendingTasks } of overloaded) {
        try {
          const alertKey = `overload_alert:${agent.agentId}`;
          const lastAlert = await this.unassignedStore.get(alertKey);

          if (
            lastAlert?.lastAlertedAt &&
            Date.now() - new Date(lastAlert.lastAlertedAt).getTime() <
              OVERLOAD_ALERT_COOLDOWN_MS
          ) {
            continue;
          }

          const mapEntry = await this.slackMap.get(agent.agentId);
          const memberId =
            typeof mapEntry === "string" ? mapEntry : mapEntry?.slack;
          const who = memberId
            ? `<@${memberId}> (${agent.name})`
            : `*${agent.name || agent.agentId}*`;

          const response = await axios($, {
            method: "POST",
            url: "https://slack.com/api/chat.postMessage",
            headers: {
              Authorization: `Bearer ${slackToken}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            data: {
              channel: alertChannel,
              text: `:warning: Agent workload alert: ${who} has ${pendingTasks} pending tasks.`,
            },
          });

          if (!response?.ok) {
            throw new Error(response?.error || "unknown Slack error");
          }

          await this.unassignedStore.set(alertKey, {
            lastAlertedAt: new Date().toISOString(),
            pendingTasks,
          });
        } catch (err) {
          console.log(
            `OVERLOAD ALERT FAILED for ${agent.agentId} (${agent.name}): ${err.message}`
          );
        }
      }
    }

    let selectedAgent;
    let mode;
    let selectedAgentPendingTasks = null;

    if (usable.length === 0) {
      // Every count query failed; never block the lead - fall back to random
      // among available agents.
      mode = "new_random_assignment_available";
      selectedAgent =
        availableAgents[Math.floor(Math.random() * availableAgents.length)];
    } else {
      const minCount = Math.min(...usable.map((c) => c.pendingTasks));
      const leastLoaded = usable.filter((c) => c.pendingTasks === minCount);
      const pick =
        leastLoaded[Math.floor(Math.random() * leastLoaded.length)];

      mode = "new_least_loaded_assignment";
      selectedAgent = pick.agent;
      selectedAgentPendingTasks = pick.pendingTasks;
    }

    if (!selectedAgent?.agentId) {
      throw new Error("Selected agent is missing agentId.");
    }

    return {
      mode,
      availableAgentsInGroup: availableAgents.length,
      selectedAgentPendingTasks,
      overloadedAgents: overloaded.map((c) => ({
        name: c.agent.name,
        pendingTasks: c.pendingTasks,
      })),
      pendingTaskCounts: Object.fromEntries(
        counts.map((c) => [
          `${c.agent.name || c.agent.agentId}`,
          c.pendingTasks,
        ])
      ),
      selectedAgentId: selectedAgent.agentId,
      selectedAgentName: selectedAgent.name || "",
      selectedAgentStatus: selectedAgent.status,
      groupId: steps.get_agents_by_group.$return_value.groupId,
      totalAgentsInGroup: agentList.length,
    };
  },
});
