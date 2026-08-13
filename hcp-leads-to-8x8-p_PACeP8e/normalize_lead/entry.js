const ALLOWED_COMPANY_IDS = new Set([
  "143e13ab-943d-483b-b9f9-14821c53c849",
  "4184e6d4-00c1-44d7-b786-db1ed2d5f1d3",
  "ccce1f7a-f510-4b9b-b571-07876258fc8b",
]);

export default defineComponent({
  async run({ steps, $ }) {
    const event = steps.trigger.event || {};
    const lead = event.lead || {};

    if (!lead?.id) {
      throw new Error("Missing lead.id from Housecall Pro webhook.");
    }

    const eventName = event.event || "";

    // Tasks are created for new leads only; agents keep tasks current in 8x8
    // manually, so HCP update events are ignored.
    if (eventName && eventName !== "lead.created") {
      $.flow.exit(
        `Skipping event "${eventName}" for lead ${lead.id}: tasks are created for new leads only.`
      );
      return;
    }

    const customer = lead.customer || {};
    const address = lead.address || {};

    const companyId = event.company_id || "";

    if (!ALLOWED_COMPANY_IDS.has(companyId)) {
      $.flow.exit(
        `Skipping lead ${lead.id}: company_id "${companyId}" is not in the allowed list.`
      );
      return;
    }

    const tenantNameMap = {
      "ccce1f7a-f510-4b9b-b571-07876258fc8b": "Premium Service Brands",
    };

    const hcpTenantName =
      event.company_name ||
      tenantNameMap[companyId] ||
      companyId ||
      "Housecall Pro";

    const firstName = customer.first_name || "";
    const lastName = customer.last_name || "";

    const fullName = [firstName, lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    const rawPhone =
      customer.mobile_number ||
      customer.phone_number ||
      "";

    const phoneDigits = String(rawPhone).replace(/\D/g, "");

    const email = customer.email || "";

    if (!phoneDigits && !email) {
      throw new Error(
        "Lead is missing both phone and email. Cannot create/find 8x8 customer."
      );
    }

    const zip = String(address.zip || "").replace(/\.0$/, "");

    const locationName = [address.city, address.state]
      .filter(Boolean)
      .join(", ");

    const hcpLeadUrl = `https://app.housecallpro.com/app/leads/${lead.id}`;

    const tags = Array.isArray(lead.tags)
      ? lead.tags
      : [];

    const totalAmount =
      lead.total_amount !== null &&
      lead.total_amount !== undefined
        ? lead.total_amount
        : 0;

    return {
      // HCP event metadata
      event: event.event || "",
      companyId,
      hcpTenantName,
      eventOccurredAt: event.event_occurred_at || "",

      // HCP lead identifiers
      hcpLeadId: lead.id,
      hcpLeadNumber: lead.number || "",
      hcpLeadUrl,

      // Customer identifiers
      hcpCustomerId: customer.id || "",

      // Customer name/contact
      firstName,
      lastName,
      fullName: fullName || "Unknown Customer",
      phone: rawPhone,
      phoneDigits,
      email,

      // Address
      addressId: address.id || "",
      address1: address.street || "",
      address2: address.street_line_2 || "",
      city: address.city || "",
      state: address.state || "",
      zip,
      locationName,

      // Lead fields
      leadSource: lead.lead_source || "Housecall Pro",
      status: lead.status || "",
      pipelineStatus: lead.pipeline_status || "",
      tags,
      totalAmount,

      // Raw useful references
      source: "housecall_pro",
      rawLead: lead,
    };
  },
});