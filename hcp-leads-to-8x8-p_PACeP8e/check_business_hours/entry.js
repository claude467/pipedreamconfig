import { axios } from "@pipedream/platform";

// 8x8 Tenant Schedule API: "*Business Hours - Insight"
const SCHEDULE_ID = 142;

export default defineComponent({
  props: {
    afterHoursStore: {
      type: "data_store",
    },
  },
  async run({ steps, $ }) {
    const tenantId =
      process.env.EIGHTX8_TENANT_ID ||
      process.env.EIGHTX8_CRM_TENANT;

    // Data Request Token (NOT the Action Request token used by agentstatus).
    const dataToken = process.env.EIGHTX8_DATA_REQUEST_TOKEN;

    // Fail open: a lead must never be blocked because the schedule check
    // itself is broken. Only a confirmed CLOSED status parks the lead.
    let statusCode = null;

    if (!tenantId || !dataToken) {
      console.log(
        "SCHEDULE CHECK SKIPPED: missing EIGHTX8_TENANT_ID/EIGHTX8_CRM_TENANT or EIGHTX8_DATA_REQUEST_TOKEN. Proceeding as open."
      );
      return { isOpen: true, degraded: true, reason: "missing_credentials" };
    }

    try {
      const auth = Buffer.from(`${tenantId}:${dataToken}`).toString("base64");

      const response = await axios($, {
        method: "GET",
        url: `${process.env.EIGHTX8_BASE_URL}/api/provisioning/schedules/${SCHEDULE_ID}/status`,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      console.log("SCHEDULE STATUS RESPONSE:", JSON.stringify(response));

      statusCode = response?.["schedule-status"]?.status;
    } catch (err) {
      console.log(
        `SCHEDULE CHECK FAILED (${err.message}). Proceeding as open.`
      );
      return { isOpen: true, degraded: true, reason: "api_error", error: err.message };
    }

    if (statusCode === undefined || statusCode === null) {
      console.log("SCHEDULE CHECK: unreadable response. Proceeding as open.");
      return { isOpen: true, degraded: true, reason: "unreadable_response" };
    }

    // 0 = OPEN, -1 = CLOSED (1-6 are custom choice states, treated as not open).
    const isOpen = statusCode === 0;

    if (isOpen) {
      return {
        isOpen: true,
        statusCode,
        scheduleId: SCHEDULE_ID,
      };
    }

    // Closed: park the lead for later processing and stop the workflow.
    const lead = steps.normalize_lead.$return_value;
    const storeKey = `after_hours:${lead.hcpLeadId}`;

    await this.afterHoursStore.set(storeKey, {
      storedAt: new Date().toISOString(),
      event: steps.trigger.event?.event || "",
      scheduleStatusCode: statusCode,
      lead,
    });

    $.flow.exit(
      `After hours (schedule ${SCHEDULE_ID} status ${statusCode}). Lead ${lead.hcpLeadId} parked under "${storeKey}".`
    );
  },
});
