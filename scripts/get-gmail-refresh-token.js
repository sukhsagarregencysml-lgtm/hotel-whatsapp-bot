// One-off helper: run this locally once to generate GOOGLE_GMAIL_REFRESH_TOKEN.
// Reuses the same OAuth client (GOOGLE_GBP_CLIENT_ID/SECRET) as the Business
// Profile setup — just enable the "Gmail API" for that same Cloud project first.
//
// IMPORTANT: sign in as whichever Google account actually RECEIVES the Google
// Business Profile review notification emails (not necessarily the account that
// manages the listing itself, if they differ).
//
// Run with: node scripts/get-gmail-refresh-token.js
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
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      signInHint: "the inbox that receives your review notification emails",
    });
    console.log("\nSuccess! Add this line to src/.env:\n");
    console.log(`GOOGLE_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
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
