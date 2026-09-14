// Daily marketing email blast — mirrors the daily marketing SMS flow in server.js.
// Reads recipient emails from a Google Sheet, sends to whoever hasn't been
// emailed yet (up to a daily cap), and tracks who's been sent to (Google Sheet +
// local file backup) so the same person isn't emailed twice.
const fs = require("fs");
const axios = require("axios");
const { google } = require("googleapis");

const EMAIL_SHEET_ID = process.env.MARKETING_EMAIL_SHEET_ID;
const EMAIL_SHEET_GID = process.env.MARKETING_EMAIL_SHEET_GID || "0";
const EMAIL_SHEET_RANGE = process.env.MARKETING_EMAIL_SHEET_RANGE || "A:A";

const SENT_EMAILS_FILE = "./sent_marketing_emails.json";
const SENT_SHEET_ID = process.env.GOOGLE_SHEET_ID || process.env.AGENTS_SHEET_ID;
const SENT_EMAILS_TAB = "SentEmails";

const DAILY_EMAIL_LIMIT = parseInt(process.env.DAILY_EMAIL_LIMIT || "150", 10);
const HOTEL_NAME = process.env.HOTEL_NAME || "Hotel Sukhsagar Regency";
const MARKETING_SUBJECT = process.env.MARKETING_EMAIL_SUBJECT || `Special Offer from ${HOTEL_NAME}, Shimla`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Render's plan blocks/blackholes outbound SMTP (465 and 587 both hang or die
// with ENETUNREACH regardless of DNS/IPv4 fixes). The Gmail API is a plain HTTPS
// call to googleapis.com, not SMTP, so it isn't affected — and it actually sends
// as the real Gmail account (correct SPF/DKIM), unlike a third-party relay trying
// to claim a @gmail.com From address. Reuses the OAuth client already set up for
// review-reading, with a separate send-scoped refresh token (see scripts/get-gmail-send-token.js).
const GMAIL_SEND_FROM = process.env.EMAIL_USER || "sukhsagarregencysml@gmail.com";
const GBP_CLIENT_ID = process.env.GOOGLE_GBP_CLIENT_ID;
const GBP_CLIENT_SECRET = process.env.GOOGLE_GBP_CLIENT_SECRET;
const GMAIL_SEND_REFRESH_TOKEN = process.env.GOOGLE_GMAIL_SEND_REFRESH_TOKEN;

function getGmailSendClient() {
  if (!GBP_CLIENT_ID || !GBP_CLIENT_SECRET || !GMAIL_SEND_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(GBP_CLIENT_ID, GBP_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_SEND_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

function encodeMimeMessage({ from, to, subject, html }) {
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendViaGmail(to, subject, html) {
  const gmail = getGmailSendClient();
  if (!gmail) throw new Error("Gmail send not configured — set GOOGLE_GMAIL_SEND_REFRESH_TOKEN");
  const raw = encodeMimeMessage({ from: `"${HOTEL_NAME}" <${GMAIL_SEND_FROM}>`, to, subject, html });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

async function fetchEmailLeads() {
  if (!EMAIL_SHEET_ID) {
    console.log("MARKETING_EMAIL_SHEET_ID not set — skipping email fetch");
    return [];
  }
  try {
    // Public CSV export — no OAuth needed, just make the sheet public (view-only).
    const csvUrl = `https://docs.google.com/spreadsheets/d/${EMAIL_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${EMAIL_SHEET_GID}&range=${EMAIL_SHEET_RANGE}`;
    const res = await axios.get(csvUrl, { timeout: 15000 });
    const emails = res.data
      .split("\n")
      .map((r) => r.replace(/"/g, "").trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e));
    const unique = [...new Set(emails)];
    console.log(`📋 Fetched ${unique.length} emails from sheet`);
    return unique;
  } catch (err) {
    console.error("Email sheet fetch error:", err.message);
    return [];
  }
}

async function loadSentEmails() {
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: (process.env.GOOGLE_SERVICE_KEY || "").replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SENT_SHEET_ID,
      range: `${SENT_EMAILS_TAB}!A:A`,
    });
    const rows = res.data.values || [];
    const emails = rows.slice(1).map((r) => r[0]).filter(Boolean);
    console.log(`✓ Loaded ${emails.length} sent emails from Google Sheet`);
    try { fs.writeFileSync(SENT_EMAILS_FILE, JSON.stringify(emails), "utf8"); } catch (e) {}
    return new Set(emails);
  } catch (e) {
    console.log("Sent-emails sheet load failed, using local file:", e.message);
    try {
      if (fs.existsSync(SENT_EMAILS_FILE)) return new Set(JSON.parse(fs.readFileSync(SENT_EMAILS_FILE, "utf8")));
    } catch (e2) {}
    return new Set();
  }
}

async function saveSentEmails(sentSet) {
  try { fs.writeFileSync(SENT_EMAILS_FILE, JSON.stringify([...sentSet]), "utf8"); } catch (e) {}
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: (process.env.GOOGLE_SERVICE_KEY || "").replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const values = [["Email"], ...[...sentSet].map((e) => [e])];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SENT_SHEET_ID,
      range: `${SENT_EMAILS_TAB}!A:A`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
    console.log(`✓ Saved ${sentSet.size} sent emails to Google Sheet`);
  } catch (e) { console.log("Sent-emails sheet save failed:", e.message); }
}

// Real photos + copy pulled from sukhsagarregency.com. The site was rebuilt on
// Next.js at some point after this template was first written — its old static
// /img/* paths all 404 now. Using only the stable /assets/* public-folder images
// (served through the Next.js image endpoint), NOT the /_next/static/media/*
// build-hashed ones, since those hashes change on every site redeploy and would
// break this template again.
const SITE = "https://www.sukhsagarregency.com";
const WA_BOOK_LINK = "https://wa.me/919816003322?text=Hi%2C%20I%27m%20interested%20in%20booking%20a%20stay";
const asset = (path, w) => `${SITE}/_next/image?url=${encodeURIComponent("/assets/" + path)}&w=${w}&q=75`;

const AMENITIES = [
  { name: "Indoor Heated Pool", img: asset("amenities/indoor-heated-pool.jpg", 640) },
  { name: "Multi-Cuisine Restaurant", img: asset("amenities/multi-cuisine-restaurant.jpg", 640) },
  { name: "Conference Hall", img: asset("amenities/conference-hall.jpg", 640) },
  { name: "Rooms With a View", img: asset("amenities/rooms-with-a-view.jpg", 640) },
  { name: "Grand Lobby", img: asset("amenities/grand-lobby.jpg", 640) },
  { name: "Dedicated Parking", img: asset("amenities/dedicated-parking.jpg", 640) },
];

function amenityCell(item) {
  return `
    <td width="33.33%" style="padding:6px" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee">
        <tr><td>
          <img src="${item.img}" alt="${item.name}" width="180" style="display:block;width:100%;max-width:180px;height:auto">
        </td></tr>
        <tr><td style="padding:8px;text-align:center;background:#fafafa">
          <span style="font-size:12px;font-weight:bold;color:#1a1a2e">${item.name}</span>
        </td></tr>
      </table>
    </td>`;
}

function marketingEmailHtml() {
  return `
  <div style="background:#f0f0f0;padding:20px 0;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">

        <!-- Header -->
        <tr><td style="background:#1a1a2e;padding:20px;text-align:center">
          <img src="${asset("logo.png", 640)}" alt="${HOTEL_NAME}" height="40" style="height:40px;width:auto">
        </td></tr>

        <!-- Hero -->
        <tr><td>
          <img src="${asset("landing-hero-1.jpg", 1200)}" alt="${HOTEL_NAME} — Shimla" width="600" style="display:block;width:100%;height:auto">
        </td></tr>
        <tr><td style="background:#C9A84C;padding:14px;text-align:center">
          <span style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:0.5px">A LUXURY RESORT IN THE SHIMLA HILLS</span>
        </td></tr>

        <!-- Welcome -->
        <tr><td style="padding:26px 28px 8px;color:#333;line-height:1.6;font-size:15px">
          <p style="margin:0 0 14px">Dear Guest,</p>
          <p style="margin:0 0 14px">
            We'd love to host you again at <strong>${HOTEL_NAME}</strong> — set at the foothills of the Himalayas
            in Taradevi, Shimla, with 50 centrally heated rooms and scenic views, an indoor heated pool, a
            multi-cuisine restaurant, and a pillarless conference hall for up to 200 guests.
          </p>
          <p style="margin:0;text-align:center">
            <a href="${WA_BOOK_LINK}" style="background:#C9A84C;color:#fff;padding:13px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">
              Book Now on WhatsApp
            </a>
          </p>
        </td></tr>

        <!-- Accommodations -->
        <tr><td style="padding:22px 22px 4px">
          <h3 style="margin:0 0 4px;color:#1a1a2e;font-size:17px;border-bottom:2px solid #C9A84C;padding-bottom:8px">Luxurious Accommodations</h3>
        </td></tr>
        <tr><td style="padding:8px 28px 8px;color:#333;line-height:1.6;font-size:14px">
          Choose from Deluxe, Super Deluxe, Honeymoon, or Executive Suite — each centrally heated in winter,
          air-conditioned in summer, and with a scenic view of the Shimla hills. Every stay includes a welcome
          drink, mineral water, and a tea/coffee maker in-room.
        </td></tr>

        <!-- Amenities -->
        <tr><td style="padding:16px 22px 4px">
          <h3 style="margin:0 0 4px;color:#1a1a2e;font-size:17px;border-bottom:2px solid #C9A84C;padding-bottom:8px">Amenities</h3>
        </td></tr>
        <tr><td style="padding:6px 12px 10px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>${amenityCell(AMENITIES[0])}${amenityCell(AMENITIES[1])}${amenityCell(AMENITIES[2])}</tr>
            <tr>${amenityCell(AMENITIES[3])}${amenityCell(AMENITIES[4])}${amenityCell(AMENITIES[5])}</tr>
          </table>
        </td></tr>

        <!-- Closing CTA -->
        <tr><td style="padding:0 28px 28px;text-align:center">
          <a href="${WA_BOOK_LINK}" style="background:#1a1a2e;color:#C9A84C;padding:13px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">
            Check Availability &amp; Rates
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#1a1a2e;padding:20px;text-align:center;font-size:12px;color:#cfcfcf">
          <strong style="color:#fff">${HOTEL_NAME}</strong><br>
          Near Goel Motors, Taradevi, Shimla, Himachal Pradesh<br>
          📞 +91 98160 03322 &nbsp;|&nbsp; 📧 info@sukhsagarregency.com &nbsp;|&nbsp; <a href="${SITE}" style="color:#C9A84C">sukhsagarregency.com</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
  </div>
  `;
}

// Sends the template to specific addresses only — no sheet fetch, no sent-tracking.
// For previewing the email in a real inbox before the daily batch runs.
async function sendTestMarketingEmail(recipients) {
  if (!getGmailSendClient()) throw new Error("Gmail send not configured — set GOOGLE_GMAIL_SEND_REFRESH_TOKEN");
  const html = marketingEmailHtml();
  const results = [];
  for (const email of recipients) {
    try {
      await sendViaGmail(email, `[TEST] ${MARKETING_SUBJECT}`, html);
      results.push({ email, ok: true });
    } catch (err) {
      results.push({ email, ok: false, error: err.response?.data?.error?.message || err.message });
    }
  }
  return results;
}

async function sendMarketingEmailBlast() {
  console.log("📧 Starting daily marketing email...");
  if (!getGmailSendClient()) {
    console.log("Gmail send not configured (GOOGLE_GMAIL_SEND_REFRESH_TOKEN) — skipping marketing email");
    return;
  }

  const allEmails = await fetchEmailLeads();
  if (!allEmails.length) {
    console.log("No emails found in sheet");
    return;
  }

  const sentEmails = await loadSentEmails();
  const newEmails = allEmails.filter((e) => !sentEmails.has(e));

  console.log(`📊 Total in sheet: ${allEmails.length} | Already sent: ${sentEmails.size} | New today: ${newEmails.length}`);

  const { sendMessage } = require("./whatsapp");
  const ADMIN = process.env.ADMIN_PHONE || "919816003322";

  if (!newEmails.length) {
    try {
      await sendMessage(ADMIN, `📧 *DAILY MARKETING EMAIL*\n\nNo new emails to send today.\nTotal ever sent: ${sentEmails.size}`);
    } catch (e) {}
    return;
  }

  const toSend = newEmails.slice(0, DAILY_EMAIL_LIMIT);
  console.log(`📊 Sending to ${toSend.length} emails today (limit: ${DAILY_EMAIL_LIMIT})`);

  const html = marketingEmailHtml();
  let sent = 0, failed = 0;

  for (const email of toSend) {
    try {
      await sendViaGmail(email, MARKETING_SUBJECT, html);
      sentEmails.add(email);
      sent++;
      console.log(`✓ Marketing email sent to ${email} (${sent}/${newEmails.length})`);
      await new Promise((r) => setTimeout(r, 600)); // stay under Gmail API rate limits
    } catch (err) {
      failed++;
      console.error(`✗ Failed to send to ${email}:`, err.response?.data?.error?.message || err.message);
    }
  }

  await saveSentEmails(sentEmails);

  try {
    const remaining = newEmails.length - toSend.length;
    await sendMessage(ADMIN,
      `📧 *DAILY MARKETING EMAIL REPORT*\n\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}\n` +
      `📋 Remaining: ${remaining + failed}\n` +
      `📊 Total ever sent: ${sentEmails.size}\n\n` +
      `Daily limit: ${DAILY_EMAIL_LIMIT} emails/day`
    );
  } catch (e) { console.error("Admin notify error:", e.message); }

  console.log(`📧 Done: ${sent} sent, ${failed} failed. Total: ${sentEmails.size}`);
}

module.exports = { sendMarketingEmailBlast, sendTestMarketingEmail, loadSentEmails, saveSentEmails };
