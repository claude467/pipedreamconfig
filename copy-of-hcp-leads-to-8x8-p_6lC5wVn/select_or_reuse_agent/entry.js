export default defineComponent({
  async run({ steps }) {
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

    const selectedAgent =
      agentList[Math.floor(Math.random() * agentList.length)];

    if (!selectedAgent?.agentId) {
      throw new Error("Selected agent is missing agentId.");
    }

    return {
      mode: "new_random_assignment",
      selectedAgentId: selectedAgent.agentId,
      selectedAgentName: selectedAgent.name || "",
      selectedAgentStatus: selectedAgent.status,
      groupId: steps.get_agents_by_group.$return_value.groupId,
      totalAgentsInGroup: agentList.length,
    };
  },
});