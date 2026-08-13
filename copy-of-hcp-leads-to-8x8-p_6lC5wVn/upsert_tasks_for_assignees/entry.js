import { axios } from "@pipedream/platform";

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function format8x8DueDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())}${date.getFullYear()}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatCurrency(value) {
  const cents = Number(value || 0);

  if (!Number.isFinite(cents)) {
    return "$0.00";
  }

  const dollars = cents / 100;

  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function sendWapi(xml, $) {
  const response = await axios($, {
    method: "POST",
    url: `${process.env.EIGHTX8_BASE_URL}/WAPI/wapi.php`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: new URLSearchParams({
      xml_query: xml,
    }).toString(),
  });

  const responseText =
    typeof response === "string" ? response : JSON.stringify(response);

  console.log("8x8 TASK RESPONSE:", responseText);

  if (
    responseText.includes('STATUS="-1"') ||
    responseText.includes('"status":-1')
  ) {
    throw new Error(`8x8 Task failed: ${responseText}`);
  }

  return responseText;
}

function extractTaskId(responseText) {
  const match =
    responseText.match(/<TASKNUM>(.*?)<\/TASKNUM>/i) ||
    responseText.match(/<TASKID>(.*?)<\/TASKID>/i) ||
    responseText.match(/"taskNum":\s*"?([^",}]+)"?/i) ||
    responseText.match(/"taskId":\s*"?([^",}]+)"?/i) ||
    responseText.match(/"taskNumber":\s*"?([^",}]+)"?/i) ||
    responseText.match(/"id":\s*"?([^",}]+)"?/i);

  return match ? match[1] : null;
}

export default defineComponent({
  props: {
    afterHoursStore: {
      type: "data_store",
    },
    unassignedStore: {
      type: "data_store",
    },
  },
  async run({ steps, $ }) {
    const lead = steps.normalize_lead.$return_value;

    const customerId =
      steps.create_or_find_8x8_customer?.$return_value?.customerId ||
      steps.create_8x8_crm_customer?.$return_value?.customerId;

    if (!customerId) {
      throw new Error("Missing customerId from customer step.");
    }

    const selectedAgentId =
      steps.select_or_reuse_agent.$return_value.selectedAgentId;

    const selectedAgentName =
      steps.select_or_reuse_agent.$return_value.selectedAgentName || "";

    if (!selectedAgentId) {
      throw new Error("Missing selectedAgentId from select_or_reuse_agent.");
    }

    const mapping = steps.get_mapping?.$return_value || {};
    const existingTaskId = mapping?.taskId;

    const dueDate = format8x8DueDate(new Date(Date.now() + 5 * 60 * 1000));

    const tenantName =
      steps.get_hcp_company?.$return_value?.tenantName ||
      "Housecall Pro";

    const subject = [
      tenantName,
      `Lead #${lead.hcpLeadNumber || lead.hcpLeadId}`,
      lead.fullName,
    ]
      .filter(Boolean)
      .join(" - ");

    const hcpLeadUrl = lead.hcpLeadUrl || "";

    const addressText = [
      lead.address1,
      lead.address2,
      lead.city,
      lead.state,
      lead.zip,
    ]
      .filter(Boolean)
      .join(", ");

    const description = [
      `Tenant: ${tenantName}`,
      `Lead Number: ${lead.hcpLeadNumber || ""}`,
      `Customer: ${lead.fullName}`,
      `Phone: ${lead.phoneDigits}`,
      `Email: ${lead.email}`,
      `Address: ${addressText}`,
      `Lead Source: ${lead.leadSource || ""}`,
      `Status: ${lead.status || ""}`,
      `Pipeline Status: ${lead.pipelineStatus || ""}`,
      `Tags: ${(lead.tags || []).join(", ")}`,
      `Amount: ${formatCurrency(lead.totalAmount)}`,
      `Last synced: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n");

    // A task already exists for this lead (e.g. a replay race after the task
    // was confirmed): never create another and never modify it - agents
    // manage task content and status manually in 8x8.
    if (existingTaskId) {
      await this.afterHoursStore.delete(`after_hours:${lead.hcpLeadId}`);
      await this.unassignedStore.delete(`no_agents:${lead.hcpLeadId}`);

      return {
        action: "skipped_existing_task",
        customerId,
        taskId: existingTaskId,
        assignedAgentId: selectedAgentId,
        assignedAgentName: selectedAgentName,
        assignmentMode: steps.select_or_reuse_agent.$return_value.mode,
        agentGroupId: steps.get_agents_by_group.$return_value.groupId,
        tenantName,
        subject,
        dueDate,
        hcpLeadUrl,
        rawResponse: null,
      };
    }

    const action = "created_task";

    const xml = `
<WAPI>
  <TENANT>${escapeXml(process.env.EIGHTX8_CRM_TENANT)}</TENANT>
  <USERNAME>${escapeXml(process.env.EIGHTX8_CRM_USERNAME)}</USERNAME>
  <PASSWORD>${escapeXml(process.env.EIGHTX8_CRM_PASSWORD)}</PASSWORD>

  <COMMAND OBJECT="Task" ACTION="Add">
    <ACCOUNTNUM>${escapeXml(customerId)}</ACCOUNTNUM>
    <SUBJECT>${escapeXml(subject)}</SUBJECT>
    <DESCRIPTION>${escapeXml(description)}</DESCRIPTION>
    <TASK_STATUS>Pending</TASK_STATUS>
    <ASSIGNEDTO>${escapeXml(selectedAgentId)}</ASSIGNEDTO>
    <CALL_TYPE>DAA</CALL_TYPE>
    <MEDIA_TYPE>Phone</MEDIA_TYPE>
    <MIDDLEWARE_URL>${escapeXml(hcpLeadUrl)}</MIDDLEWARE_URL>
    <PHONE>${escapeXml(lead.phoneDigits)}</PHONE>
    <EMAIL>${escapeXml(lead.email)}</EMAIL>
    <DUEDATE>${escapeXml(dueDate)}</DUEDATE>
  </COMMAND>
</WAPI>`.trim();

    const responseText = await sendWapi(xml, $);
    const taskId = extractTaskId(responseText);

    if (!taskId) {
      throw new Error(
        `Task ${action} succeeded but task ID was not found. Response: ${responseText}`
      );
    }

    // Task confirmed: this lead is no longer parked. The drainer deliberately
    // does NOT delete parked keys - a lead leaves the lot only here, once its
    // task provably exists (deleting a missing key is a harmless no-op).
    await this.afterHoursStore.delete(`after_hours:${lead.hcpLeadId}`);
    await this.unassignedStore.delete(`no_agents:${lead.hcpLeadId}`);

    return {
      action,
      customerId,
      taskId,
      assignedAgentId: selectedAgentId,
      assignedAgentName: selectedAgentName,
      assignmentMode: steps.select_or_reuse_agent.$return_value.mode,
      agentGroupId: steps.get_agents_by_group.$return_value.groupId,
      tenantName,
      subject,
      dueDate,
      hcpLeadUrl,
      rawResponse: responseText,
    };
  },
});