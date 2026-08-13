import { axios } from "@pipedream/platform";

// DM the assigned agent on Slack when a new task is created. This step must
// never fail the run: the task already exists in 8x8, so every problem here
// (missing token, unmapped agent, Slack outage) logs and continues.

async function slackApi(method, token, payload, $) {
  const response = await axios($, {
    method: "POST",
    url: `https://slack.com/api/${method}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    data: payload,
  });

  if (!response?.ok) {
    throw new Error(`Slack ${method} failed: ${response?.error || JSON.stringify(response).slice(0, 200)}`);
  }

  return response;
}

export default defineComponent({
  props: {
    slackMap: {
      type: "data_store",
    },
  },
  async run({ steps, $ }) {
    const task = steps.upsert_tasks_for_assignees?.$return_value || {};

    if (task.action !== "created_task") {
      return { notified: false, reason: `skipped: action was "${task.action}"` };
    }

    const token = process.env.SLACK_BOT_TOKEN;

    if (!token) {
      console.log("SLACK NOTIFY SKIPPED: SLACK_BOT_TOKEN is not set.");
      return { notified: false, reason: "missing_token" };
    }

    const agentId = task.assignedAgentId;
    const mapEntry = await this.slackMap.get(agentId);

    // Mapping value may be a plain string ("U123...") or {"slack": "U123..."}.
    const memberId =
      typeof mapEntry === "string" ? mapEntry : mapEntry?.slack;

    if (!memberId) {
      console.log(
        `SLACK NOTIFY SKIPPED: no Slack mapping for agent ${agentId} (${task.assignedAgentName}).`
      );
      return { notified: false, reason: "agent_not_mapped", agentId };
    }

    const lead = steps.normalize_lead.$return_value;

    // Tasks page in 8x8 Agent Workspace (set EIGHTX8_TASKS_URL in Pipedream).
    const tasksUrl = process.env.EIGHTX8_TASKS_URL || "";

    const lines = [
      `:telephone_receiver: *New lead assigned to you*`,
      [
        `Lead #${lead.hcpLeadNumber || lead.hcpLeadId}`,
        lead.fullName,
        lead.locationName,
      ]
        .filter(Boolean)
        .join(" — "),
      tasksUrl ? `<${tasksUrl}|Open your 8x8 tasks>` : "",
    ].filter(Boolean);

    try {
      const conversation = await slackApi(
        "conversations.open",
        token,
        { users: memberId },
        $
      );

      await slackApi(
        "chat.postMessage",
        token,
        {
          channel: conversation.channel.id,
          text: lines.join("\n"),
          unfurl_links: false,
        },
        $
      );

      return {
        notified: true,
        memberId,
        agentId,
        agentName: task.assignedAgentName,
      };
    } catch (err) {
      console.log(`SLACK NOTIFY FAILED: ${err.message}`);
      return { notified: false, reason: "slack_error", error: err.message };
    }
  },
});
