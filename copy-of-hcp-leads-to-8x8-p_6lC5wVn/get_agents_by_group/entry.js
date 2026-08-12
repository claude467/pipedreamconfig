import { axios } from "@pipedream/platform";

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

export default defineComponent({
  async run({ steps, $ }) {
    const tenantId =
      process.env.EIGHTX8_TENANT_ID ||
      process.env.EIGHTX8_CRM_TENANT;

    const actionToken = process.env.EIGHTX8_ACTION_TOKEN;
    // TEST COPY: pinned to "Test Agent Group" (3350) so runs never touch the
    // production group configured in EIGHTX8_AGENT_GROUP_ID.
    const groupId = "3350";

    if (!tenantId) {
      throw new Error("Missing EIGHTX8_TENANT_ID or EIGHTX8_CRM_TENANT.");
    }

    if (!actionToken) {
      throw new Error("Missing EIGHTX8_ACTION_TOKEN.");
    }

    if (!groupId) {
      throw new Error("Missing EIGHTX8_AGENT_GROUP_ID.");
    }

    const response = await axios($, {
      method: "GET",
      url: `${process.env.EIGHTX8_BASE_URL}/api/v1/tenants/${tenantId}/agentstatus/agents?groupId=${encodeURIComponent(groupId)}`,
      headers: {
        Authorization: `Basic ${basicAuth(tenantId, actionToken)}`,
      },
    });

    console.log("AGENTS BY GROUP RESPONSE:", JSON.stringify(response, null, 2));

    const agents = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : response?.agents || [];

    const agentList = agents
      .map((agent) => ({
        agentId: agent["agent-id"],
        name: agent.name || "",
        status: agent["agent-status"],
        raw: agent,
      }))
      .filter((agent) => agent.agentId);

    const agentIds = agentList.map((agent) => agent.agentId);

    if (agentIds.length === 0) {
      throw new Error(`No agent IDs found for groupId: ${groupId}`);
    }

    return {
      groupId,
      totalAgents: agentIds.length,
      agentIds,
      agentList,
    };
  },
});