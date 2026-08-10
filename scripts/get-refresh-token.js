// One-off helper: run this locally once to generate GOOGLE_GBP_REFRESH_TOKEN.
// Requires GOOGLE_GBP_CLIENT_ID and GOOGLE_GBP_CLIENT_SECRET already set in src/.env.
//
// Run with: node scripts/get-refresh-token.js
require("dotenv").config({ path: require("path").join(__dirname, "../src/.env") });
const { getRefreshToken } = require("./_oauth-loopback");

async function main() {
  const { GOOGLE_GBP_CLIENT_ID, GOOGLE_GBP_CLIENT_SECRET } = process.env;
  if (!GOOGLE_GBP_CLIENT_ID || !GOOGLE_GBP_CLIENT_SECRET) {
    console.error("Set GOOGLE_GBP_CLIENT_ID and GOOGLE_GBP_CLIENT_SECRET in src/.env first.");
    process.exit(1);
  }

  try {
    const tokens = await getRefreshToken({
      clientId: GOOGLE_GBP_CLIENT_ID,
      clientSecret: GOOGLE_GBP_CLIENT_SECRET,
      scope: "https://www.googleapis.com/auth/business.manage",
      signInHint: "the account that manages your hotel's Business Profile",
    });
    console.log("\nSuccess! Add this line to src/.env:\n");
    console.log(`GOOGLE_GBP_REFRESH_TOKEN=${tokens.refresh_token}`);
    if (!tokens.refresh_token) {
      console.log("\nNo refresh_token was returned — you've likely already granted this app access before.");
      console.log("Revoke it at https://myaccount.google.com/permissions and run this script again.");
    }
  } catch (e) {
    console.error("Failed:", e.response?.data || e.message);
    process.exit(1);
  }
}

main();
