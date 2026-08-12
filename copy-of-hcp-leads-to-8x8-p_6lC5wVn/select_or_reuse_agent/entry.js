export default defineComponent({
  props: {
    unassignedStore: {
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

    // Otherwise, randomly assign for the first time.
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

    const mode = "new_random_assignment_available";

    const selectedAgent =
      availableAgents[Math.floor(Math.random() * availableAgents.length)];

    if (!selectedAgent?.agentId) {
      throw new Error("Selected agent is missing agentId.");
    }

    return {
      mode,
      availableAgentsInGroup: availableAgents.length,
      selectedAgentId: selectedAgent.agentId,
      selectedAgentName: selectedAgent.name || "",
      selectedAgentStatus: selectedAgent.status,
      groupId: steps.get_agents_by_group.$return_value.groupId,
      totalAgentsInGroup: agentList.length,
    };
  },
});