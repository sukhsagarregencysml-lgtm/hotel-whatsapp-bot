// Daily marketing email blast — mirrors the daily marketing SMS flow in server.js.
// Reads recipient emails from a Google Sheet, sends to whoever hasn't been
// emailed yet (up to a daily cap), and tracks who's been sent to (Google Sheet +
// local file backup) so the same person isn't emailed twice.
const fs = require("fs");
const axios = require("axios");
const nodemailer = require("nodemailer");

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

function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER || "info@sukhsagarregency.com",
      pass: process.env.EMAIL_PASS,
    },
  });
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

function marketingEmailHtml() {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a1a2e;padding:24px;text-align:center">
        <h2 style="color:#C9A84C;margin:0">${HOTEL_NAME}</h2>
        <p style="color:#fff;margin:6px 0;font-size:14px">Shimla, Himachal Pradesh</p>
      </div>
      <div style="padding:24px;border:1px solid #eee;color:#333;line-height:1.6">
        <p>Dear Guest,</p>
        <p>We'd love to host you again at ${HOTEL_NAME}. Enjoy special rates on your next stay in the hills of Shimla — comfortable rooms, great views, and warm hospitality await.</p>
        <p style="text-align:center;margin:28px 0">
          <a href="https://wa.me/919816003322?text=Hi%2C%20I%27m%20interested%20in%20booking%20a%20stay"
             style="background:#C9A84C;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold">
            Book Now on WhatsApp
          </a>
        </p>
        <p>Reply to this email or call us to check availability and rates.</p>
      </div>
      <div style="background:#f5f5f5;padding:15px;text-align:center;font-size:12px;color:#666">
        ${HOTEL_NAME}, Shimla, Himachal Pradesh<br>
        📞 +91 98160 03322 | info@sukhsagarregency.com
      </div>
    </div>
  `;
}

async function sendMarketingEmailBlast() {
  console.log("📧 Starting daily marketing email...");
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("EMAIL_USER/EMAIL_PASS not set — skipping marketing email");
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

  const transporter = getTransporter();
  const html = marketingEmailHtml();
  let sent = 0, failed = 0;

  for (const email of toSend) {
    try {
      await transporter.sendMail({
        from: `"${HOTEL_NAME}" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: MARKETING_SUBJECT,
        html,
      });
      sentEmails.add(email);
      sent++;
      console.log(`✓ Marketing email sent to ${email} (${sent}/${newEmails.length})`);
      await new Promise((r) => setTimeout(r, 800)); // avoid Gmail rate limiting
    } catch (err) {
      failed++;
      console.error(`✗ Failed to send to ${email}:`, err.message);
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

module.exports = { sendMarketingEmailBlast, loadSentEmails, saveSentEmails };
