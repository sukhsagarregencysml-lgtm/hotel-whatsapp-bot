// One-off helper: prints your Google Business Profile Account ID(s) and Location ID(s)
// so you can copy them into .env as GOOGLE_GBP_ACCOUNT_ID / GOOGLE_GBP_LOCATION_ID.
//
// Requires GOOGLE_GBP_CLIENT_ID, GOOGLE_GBP_CLIENT_SECRET, GOOGLE_GBP_REFRESH_TOKEN in .env.
// Run with: node scripts/list-gbp-locations.js
require("dotenv").config({ path: require("path").join(__dirname, "../src/.env") });
const axios = require("axios");
const { google } = require("googleapis");

async function main() {
  const client = new google.auth.OAuth2(process.env.GOOGLE_GBP_CLIENT_ID, process.env.GOOGLE_GBP_CLIENT_SECRET);
  client.setCredentials({ refresh_token: process.env.GOOGLE_GBP_REFRESH_TOKEN });
  const { token } = await client.getAccessToken();

  const accountsRes = await axios.get("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = accountsRes.data?.accounts || [];
  if (!accounts.length) {
    console.log("No Business Profile accounts found for this Google account.");
    return;
  }

  for (const account of accounts) {
    const accountId = account.name.split("/")[1];
    console.log(`\nAccount: ${account.accountName || account.name}  (accountId=${accountId})`);

    const locationsRes = await axios.get(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
      { headers: { Authorization: `Bearer ${token}` }, params: { readMask: "name,title" } }
    );
    const locations = locationsRes.data?.locations || [];
    if (!locations.length) {
      console.log("  (no locations under this account)");
      continue;
    }
    for (const loc of locations) {
      const locationId = loc.name.split("/")[1];
      console.log(`  - ${loc.title}  (locationId=${locationId})`);
    }
  }

  console.log("\nCopy the accountId and locationId for your hotel into .env as GOOGLE_GBP_ACCOUNT_ID and GOOGLE_GBP_LOCATION_ID.");
}

main().catch((e) => {
  console.error("Failed:", e.response?.data || e.message);
  process.exit(1);
});
