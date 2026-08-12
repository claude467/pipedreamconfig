import { axios } from "@pipedream/platform";

function escapeXml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizePhone(value = "") {
  return String(value ?? "").replace(/\D/g, "");
}

function extractCustomerId(text = "") {
  const patterns = [
    /<ACCOUNTNUM>(.*?)<\/ACCOUNTNUM>/i,
    /<ACCOUNT_NUM>(.*?)<\/ACCOUNT_NUM>/i,
    /<ACCOUNTID>(.*?)<\/ACCOUNTID>/i,
    /<ACCOUNT_ID>(.*?)<\/ACCOUNT_ID>/i,
    /ACCOUNTNUM=["']([^"']+)["']/i,
    /ACCOUNT_NUM=["']([^"']+)["']/i,
    /ACCOUNTID=["']([^"']+)["']/i,
    /ACCOUNT_ID=["']([^"']+)["']/i,
    /"accountNumber":\s*"?(\d+)"?/i,
    /"accountnum":\s*"?(\d+)"?/i,
    /"id":\s*"?(\d+)"?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function extractErrorCode(text = "") {
  try {
    const parsed = JSON.parse(text);

    return (
      parsed?.reply?.errorCode ||
      parsed?.reply?.error_code ||
      parsed?.reply?.status ||
      parsed?.errorCode ||
      null
    );
  } catch (e) {
    const match =
      text.match(/ERROR_CODE=["']?(\d+)["']?/i) ||
      text.match(/STATUS=["']?(\d+)["']?/i) ||
      text.match(/"errorCode":\s*"?(\d+)"?/i) ||
      text.match(/"status":\s*"?(\d+)"?/i);

    return match?.[1] || null;
  }
}

async function call8x8(xml, $, env, label = "8x8 RESPONSE") {
  const response = await axios($, {
    method: "POST",
    url: `${env.EIGHTX8_BASE_URL}/WAPI/wapi.php`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: new URLSearchParams({
      xml_query: xml,
    }).toString(),
  });

  const text = typeof response === "string" ? response : JSON.stringify(response);

  console.log(label, text);

  return text;
}

async function findCustomerByEmail(email, $, env) {
  if (!email) return null;

  const xml = `
<WAPI>
  <TENANT>${escapeXml(env.EIGHTX8_CRM_TENANT)}</TENANT>
  <USERNAME>${escapeXml(env.EIGHTX8_CRM_USERNAME)}</USERNAME>
  <PASSWORD>${escapeXml(env.EIGHTX8_CRM_PASSWORD)}</PASSWORD>

  <COMMAND OBJECT="Customer" ACTION="Get">
    <EMAIL>${escapeXml(email)}</EMAIL>
  </COMMAND>
</WAPI>`.trim();

  const text = await call8x8(xml, $, env, "LOOKUP BY EMAIL RESPONSE:");

  try {
    const parsed = JSON.parse(text);

    const customerId =
      parsed?.reply?.items?.[0]?.id ||
      parsed?.reply?.items?.[0]?.accountNumber ||
      parsed?.reply?.items?.[0]?.accountnum ||
      parsed?.reply?.accountNumber ||
      parsed?.reply?.accountnum ||
      null;

    if (customerId) return String(customerId);
  } catch (e) {}

  return extractCustomerId(text);
}

async function findCustomerByPhone(phoneDigits, $, env) {
  if (!phoneDigits) return null;

  const xml = `
<WAPI>
  <TENANT>${escapeXml(env.EIGHTX8_CRM_TENANT)}</TENANT>
  <USERNAME>${escapeXml(env.EIGHTX8_CRM_USERNAME)}</USERNAME>
  <PASSWORD>${escapeXml(env.EIGHTX8_CRM_PASSWORD)}</PASSWORD>

  <COMMAND OBJECT="Customer" ACTION="Get">
    <VOICE>${escapeXml(phoneDigits)}</VOICE>
  </COMMAND>
</WAPI>`.trim();

  const text = await call8x8(xml, $, env, "LOOKUP BY PHONE RESPONSE:");

  try {
    const parsed = JSON.parse(text);

    const customerId =
      parsed?.reply?.items?.[0]?.id ||
      parsed?.reply?.items?.[0]?.accountNumber ||
      parsed?.reply?.items?.[0]?.accountnum ||
      parsed?.reply?.accountNumber ||
      parsed?.reply?.accountnum ||
      null;

    if (customerId) return String(customerId);
  } catch (e) {}

  return extractCustomerId(text);
}

async function createCustomer(lead, $, env, outboundQueueId) {
  const firstName = lead.firstName || "Housecall Pro";
  const lastName = lead.lastName || `Lead ${lead.hcpLeadNumber || lead.hcpLeadId || ""}`.trim();

  const zip = String(lead.zip || "").replace(/\.0$/, "");

  const comments = [
    "Created from Housecall Pro lead.created webhook.",
    `HCP Lead ID: ${lead.hcpLeadId || ""}`,
    `HCP Lead Number: ${lead.hcpLeadNumber || ""}`,
    `Lead Source: ${lead.leadSource || ""}`,
    `Pipeline Status: ${lead.pipelineStatus || ""}`,
    `Lead Status: ${lead.status || ""}`,
    `Total Amount: ${lead.totalAmount || 0}`,
    `Tags: ${Array.isArray(lead.tags) ? lead.tags.join(", ") : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  const xml = `
<WAPI>
  <TENANT>${escapeXml(env.EIGHTX8_CRM_TENANT)}</TENANT>
  <USERNAME>${escapeXml(env.EIGHTX8_CRM_USERNAME)}</USERNAME>
  <PASSWORD>${escapeXml(env.EIGHTX8_CRM_PASSWORD)}</PASSWORD>

  <COMMAND OBJECT="Customer" ACTION="Add">
    <FIRSTNAME>${escapeXml(firstName)}</FIRSTNAME>
    <LASTNAME>${escapeXml(lastName)}</LASTNAME>
    <EMAIL>${escapeXml(lead.email || "")}</EMAIL>
    <VOICE>${escapeXml(lead.phoneDigits || lead.phone || "")}</VOICE>
    <AUTOPASSWD>TRUE</AUTOPASSWD>

    <ADDR1STR1>${escapeXml(lead.address1 || "")}</ADDR1STR1>
    <ADDR1STR2>${escapeXml(lead.address2 || "")}</ADDR1STR2>
    <ADDR1CITY>${escapeXml(lead.city || "")}</ADDR1CITY>
    <ADDR1STATE>${escapeXml(lead.state || "")}</ADDR1STATE>
    <ADDR1ZIP>${escapeXml(zip)}</ADDR1ZIP>

    <COMMENTS>${escapeXml(comments)}</COMMENTS>

    <queue_id>${escapeXml(outboundQueueId)}</queue_id>
  </COMMAND>
</WAPI>`.trim();

  const responseText = await call8x8(xml, $, env, "CREATE CUSTOMER RESPONSE:");

  let customerId = null;
  let errorCode = null;

  try {
    const parsed = JSON.parse(responseText);

    if (Number(parsed?.reply?.status) === 0) {
      customerId =
        parsed?.reply?.accountNumber ||
        parsed?.reply?.accountnum ||
        parsed?.reply?.id ||
        null;
    }

    errorCode = parsed?.reply?.errorCode || parsed?.reply?.error_code || null;
  } catch (e) {
    errorCode = extractErrorCode(responseText);
  }

  if (!customerId) {
    customerId = extractCustomerId(responseText);
  }

  return {
    customerId: customerId ? String(customerId) : null,
    errorCode: errorCode ? String(errorCode) : null,
    rawResponse: responseText,
  };
}

export default defineComponent({
  async run({ steps, $ }) {
    const lead = steps.normalize_lead.$return_value;
    const outboundQueueId = process.env.EIGHTX8_OUTBOUND_QUEUE_ID || "3258";

    if (!lead) {
      throw new Error("Missing normalized lead from previous step.");
    }

    if (!process.env.EIGHTX8_BASE_URL) {
      throw new Error("Missing environment variable: EIGHTX8_BASE_URL");
    }

    if (!process.env.EIGHTX8_CRM_TENANT) {
      throw new Error("Missing environment variable: EIGHTX8_CRM_TENANT");
    }

    if (!process.env.EIGHTX8_CRM_USERNAME) {
      throw new Error("Missing environment variable: EIGHTX8_CRM_USERNAME");
    }

    if (!process.env.EIGHTX8_CRM_PASSWORD) {
      throw new Error("Missing environment variable: EIGHTX8_CRM_PASSWORD");
    }

    if (!lead.hcpLeadId) {
      throw new Error("Missing HCP lead ID from normalized lead.");
    }

    if (!lead.email && !lead.phoneDigits) {
      throw new Error("Missing both email and phoneDigits. Cannot find or create 8x8 customer safely.");
    }

    let customerId = null;
    let lookupMethod = null;

    /**
     * 1. Find existing customer by email.
     */
    if (lead.email) {
      customerId = await findCustomerByEmail(lead.email, $, process.env);

      if (customerId) {
        lookupMethod = "email";
      }
    }

    /**
     * 2. If not found by email, find by phone.
     */
    if (!customerId && lead.phoneDigits) {
      customerId = await findCustomerByPhone(lead.phoneDigits, $, process.env);

      if (customerId) {
        lookupMethod = "phone";
      }
    }

    /**
     * 3. If customer already exists, return it.
     */
    if (customerId) {
      return {
        action: "found",
        customerId,
        accountNum: customerId,
        lookupMethod,
        queueId: outboundQueueId,
        lead,
      };
    }

    /**
     * 4. Create customer if not found.
     */
    const createResult = await createCustomer(
      lead,
      $,
      process.env,
      outboundQueueId
    );

    customerId = createResult.customerId;

    /**
     * 5. Handle duplicate email error by looking up customer again.
     * Your previous script used errorCode 81 for duplicate email, so this keeps that logic.
     */
    if (!customerId && Number(createResult.errorCode) === 81 && lead.email) {
      console.log("Duplicate email detected, performing lookup...");

      customerId = await findCustomerByEmail(
        lead.email,
        $,
        process.env
      );

      if (customerId) {
        return {
          action: "found_after_duplicate",
          customerId,
          accountNum: customerId,
          lookupMethod: "email_after_duplicate",
          queueId: outboundQueueId,
          rawResponse: createResult.rawResponse,
          lead,
        };
      }
    }

    if (!customerId) {
      throw new Error(
        `Customer create/lookup failed. Full response: ${createResult.rawResponse}`
      );
    }

    return {
      action: "created",
      customerId,
      accountNum: customerId,
      queueId: outboundQueueId,
      rawResponse: createResult.rawResponse,
      lead,
    };
  },
});