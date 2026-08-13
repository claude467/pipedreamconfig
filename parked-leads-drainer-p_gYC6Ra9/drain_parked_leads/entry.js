import { axios } from "@pipedream/platform";

// 8x8 Tenant Schedule API: "*Business Hours - Insight"
const SCHEDULE_ID = 142;

// Live "HCP Leads to 8x8" trigger endpoint. Parked leads are replayed here so
// they take the exact same path (filters, hours check, availability) as fresh
// webhooks. If conditions changed since our pre-checks, the live workflow
// simply re-parks them.
const TARGET_URL = "https://eolwxz2l06fbzyy.m.pipedream.net";

const KEY_PREFIXES = ["after_hours:", "no_agents:"];

// Safety cap per tick; anything beyond this waits for the next run.
const MAX_PER_RUN = 25;

// Never wake more leads than available agents can plausibly absorb per tick.
const PER_AGENT_CAP = 3;

// A lead replayed this many times without the live workflow confirming a task
// (which deletes its key) gets shelved under "dead:" for manual review.
const MAX_REPLAY_ATTEMPTS = 10;

export default defineComponent({
  props: {
    parkedStore: {
      type: "data_store",
    },
  },
  async run({ $ }) {
    // 1) Any parked leads?
    const allKeys = await this.parkedStore.keys();
    const parkedKeys = allKeys.filter((k) =>
      KEY_PREFIXES.some((p) => k.startsWith(p))
    );

    if (parkedKeys.length === 0) {
      $.flow.exit("No parked leads in data store.");
      return;
    }

    const tenantId =
      process.env.EIGHTX8_TENANT_ID ||
      process.env.EIGHTX8_CRM_TENANT;
    const dataToken = process.env.EIGHTX8_DATA_REQUEST_TOKEN;
    const actionToken = process.env.EIGHTX8_ACTION_TOKEN;
    const groupId = process.env.EIGHTX8_AGENT_GROUP_ID;

    if (!tenantId || !dataToken || !actionToken || !groupId) {
      throw new Error(
        "Missing one of EIGHTX8_TENANT_ID/EIGHTX8_CRM_TENANT, EIGHTX8_DATA_REQUEST_TOKEN, EIGHTX8_ACTION_TOKEN, EIGHTX8_AGENT_GROUP_ID."
      );
    }

    // 2) Business hours open right now?
    const dataAuth = Buffer.from(`${tenantId}:${dataToken}`).toString("base64");

    const scheduleResponse = await axios($, {
      method: "GET",
      url: `${process.env.EIGHTX8_BASE_URL}/api/provisioning/schedules/${SCHEDULE_ID}/status`,
      headers: {
        Authorization: `Basic ${dataAuth}`,
        Accept: "application/json",
      },
    });

    const statusCode = scheduleResponse?.["schedule-status"]?.status;

    if (statusCode !== 0) {
      $.flow.exit(
        `Schedule ${SCHEDULE_ID} not open (status ${statusCode}). ${parkedKeys.length} lead(s) stay parked.`
      );
      return;
    }

    // 3) Any available agents in the group?
    const actionAuth = Buffer.from(`${tenantId}:${actionToken}`).toString(
      "base64"
    );

    const agentsResponse = await axios($, {
      method: "GET",
      url: `${process.env.EIGHTX8_BASE_URL}/api/v1/tenants/${tenantId}/agentstatus/agents?groupId=${encodeURIComponent(groupId)}`,
      headers: {
        Authorization: `Basic ${actionAuth}`,
      },
    });

    const agents = Array.isArray(agentsResponse?.data)
      ? agentsResponse.data
      : Array.isArray(agentsResponse)
        ? agentsResponse
        : agentsResponse?.agents || [];

    // 8x8 agent-status 4 = WAIT_TRANSACT (available, waiting for work).
    const availableAgents = agents.filter((a) => a["agent-status"] === 4);

    if (availableAgents.length === 0) {
      $.flow.exit(
        `No available agents in group ${groupId}. ${parkedKeys.length} lead(s) stay parked.`
      );
      return;
    }

    // 4) Replay parked leads to the live workflow. The drainer never deletes
    // a parked key on replay: the live workflow deletes it only after 8x8
    // confirms the task, so a lead can't be lost to a failed run. Re-parking
    // and re-replaying the same key is idempotent (set() overwrites; an
    // already-assigned lead takes the sticky-reuse path and just updates its
    // existing task).
    const capacity = Math.min(MAX_PER_RUN, availableAgents.length * PER_AGENT_CAP);
    const toProcess = parkedKeys.slice(0, capacity);
    const results = [];

    for (const key of toProcess) {
      const record = await this.parkedStore.get(key);

      if (!record?.lead?.rawLead) {
        // Unusable record; drop it so it doesn't clog every run.
        await this.parkedStore.delete(key);
        results.push({ key, action: "deleted_malformed" });
        continue;
      }

      const attempts = record.replayCount || 0;

      if (attempts >= MAX_REPLAY_ATTEMPTS) {
        // The live workflow keeps failing to confirm this lead; shelve it so
        // it stops burning replays but stays inspectable.
        await this.parkedStore.set(`dead:${key}`, record);
        await this.parkedStore.delete(key);
        results.push({ key, action: "shelved_after_max_attempts" });
        continue;
      }

      const body = {
        event: record.event || "lead.created",
        company_id: record.lead.companyId || "",
        company_name: record.lead.hcpTenantName || "",
        event_occurred_at: record.lead.eventOccurredAt || "",
        lead: record.lead.rawLead,
      };

      try {
        await axios($, {
          method: "POST",
          url: TARGET_URL,
          headers: {
            "Content-Type": "application/json",
          },
          data: body,
        });

        await this.parkedStore.set(key, {
          ...record,
          replayCount: attempts + 1,
          lastReplayedAt: new Date().toISOString(),
        });
        results.push({ key, action: "replayed", attempt: attempts + 1 });
      } catch (err) {
        // Keep the key untouched; next tick retries.
        results.push({ key, action: "failed", error: err.message });
      }
    }

    const replayed = results.filter((r) => r.action === "replayed").length;
    const failed = results.filter((r) => r.action === "failed").length;

    console.log(
      `Drained ${replayed}/${toProcess.length} parked lead(s); ${failed} failed; ${parkedKeys.length - toProcess.length} deferred to next run.`
    );

    return {
      parkedFound: parkedKeys.length,
      replayed,
      failed,
      deferred: parkedKeys.length - toProcess.length,
      availableAgentsInGroup: availableAgents.length,
      results,
    };
  },
});
