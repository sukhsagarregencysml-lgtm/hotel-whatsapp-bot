// One-off helper: run this locally once to generate GOOGLE_GMAIL_SEND_REFRESH_TOKEN,
// used to send the daily marketing email as sukhsagarregencysml@gmail.com via the
// Gmail API (not SMTP — Render blocks outbound SMTP on this plan, but the Gmail API
// is a plain HTTPS call so it isn't affected).
//
// Reuses the same OAuth client (GOOGLE_GBP_CLIENT_ID/SECRET) as the Business Profile
// / review-reading setup — just make sure the "Gmail API" is enabled for that same
// Google Cloud project first (console.cloud.google.com > APIs & Services > Library).
//
// IMPORTANT: sign in as sukhsagarregencysml@gmail.com — the account the marketing
// email should actually be sent from.
//
// Run with: node scripts/get-gmail-send-token.js
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
      scope: "https://www.googleapis.com/auth/gmail.send",
      signInHint: "sukhsagarregencysml@gmail.com",
    });
    console.log("\nSuccess! Add this line to src/.env (and to Render's Environment tab):\n");
    console.log(`GOOGLE_GMAIL_SEND_REFRESH_TOKEN=${tokens.refresh_token}`);
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
