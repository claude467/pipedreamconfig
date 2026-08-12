import { axios } from "@pipedream/platform";

export default defineComponent({
  async run({ steps, $ }) {
    const apiKey = process.env.HCP_API_KEY;
    const webhookCompanyId = steps.normalize_lead.$return_value.companyId;

    if (!apiKey) {
      throw new Error("Missing HCP_API_KEY.");
    }

    if (!webhookCompanyId) {
      throw new Error("Missing companyId from normalize_lead.");
    }

    const response = await axios($, {
      method: "GET",
      url: "https://api.housecallpro.com/company",
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
    });

    const parentCompanyName = response?.name || "";
    const locations = Array.isArray(response?.locations)
      ? response.locations
      : [];

    console.log("HCP COMPANY RAW RESPONSE:", JSON.stringify(response, null, 2));
    console.log("HCP LOCATIONS COUNT:", locations.length);

    const matchingLocation = locations.find((location) => {
      return (
        location?.id === webhookCompanyId ||
        location?.company_id === webhookCompanyId ||
        location?.location_id === webhookCompanyId
      );
    });

    if (!matchingLocation) {
      return {
        found: false,
        webhookCompanyId,
        tenantName: parentCompanyName || "Housecall Pro",
        parentCompanyName,
        locationsCount: locations.length,
        sampleLocations: locations.slice(0, 10),
        message:
          "No matching location found by webhook company_id. Check sampleLocations to identify the correct ID field.",
      };
    }

    const tenantName =
      matchingLocation.name ||
      matchingLocation.company_name ||
      matchingLocation.location_name ||
      matchingLocation.display_name ||
      parentCompanyName ||
      "Housecall Pro";

    return {
      found: true,
      webhookCompanyId,
      tenantName,
      parentCompanyName,
      locationId:
        matchingLocation.id ||
        matchingLocation.company_id ||
        matchingLocation.location_id ||
        "",
      matchingLocation,
      locationsCount: locations.length,
    };
  },
});