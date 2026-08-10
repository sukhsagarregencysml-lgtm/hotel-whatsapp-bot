// Interim review detection via Gmail — used until Google approves Business Profile
// API access (see googleReviews.js for the API-based version, which posts replies
// automatically). This version can only notify + draft; a human copies the reply
// into the Business Profile app since there's no API access to post it.
const fs = require("fs");
const { google } = require("googleapis");
const { draftReplyForRating, starsDisplay } = require("./reviewReplyTemplates");

const CLIENT_ID = process.env.GOOGLE_GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_GBP_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GOOGLE_GMAIL_REFRESH_TOKEN;

const PROCESSED_FILE = "./processed_review_emails.json";

// Broad net: Google's review notification subject lines vary ("You have a new
// review", "X left you a review", "New review for ..."), so we search on the
// common word rather than an exact phrase, scoped to recent unread mail.
const GMAIL_QUERY = 'subject:(review) newer_than:3d';

function getGmailClient() {
  if (!CLIENT_ID || !CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")));
  } catch (e) { console.error("Load processed review emails error:", e.message); }
  return new Set();
}

function saveProcessedIds(set) {
  try { fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set]), "utf8"); }
  catch (e) { console.error("Save processed review emails error:", e.message); }
}

function decodeBody(payload) {
  function walk(part) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  }
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf8");
  return walk(payload) || "";
}

// Best-effort extraction — Google's exact email wording isn't guaranteed to stay
// stable, so the WhatsApp notification always includes the raw snippet as a
// fallback in case a field isn't picked up correctly.
function parseReviewFromEmail(subject, body) {
  const nameMatch = subject.match(/from ([A-Za-z][\w' .-]*)/i) || body.match(/^([A-Za-z][\w' .-]*) (?:left|wrote|rated)/im);
  const reviewer = nameMatch ? nameMatch[1].trim() : "";

  let rating = 0;
  const starWordMatch = body.match(/(\d)(?:\s*-\s*|\s+)star/i) || subject.match(/(\d)(?:\s*-\s*|\s+)star/i);
  if (starWordMatch) rating = parseInt(starWordMatch[1], 10);
  if (!rating) {
    const starGlyphs = (body.match(/★/g) || []).length;
    if (starGlyphs >= 1 && starGlyphs <= 5) rating = starGlyphs;
  }

  const quoteMatch = body.match(/"([^"]{5,700})"/);
  const comment = quoteMatch ? quoteMatch[1].trim() : "";

  return { reviewer, rating, comment };
}

function makeShortId(gmailMessageId) {
  return "E" + gmailMessageId.slice(-4).toUpperCase();
}

async function checkReviewEmails() {
  const gmail = getGmailClient();
  if (!gmail) {
    console.log("Google review email check skipped — Gmail credentials not configured");
    return;
  }
  const { sendMessage } = require("./whatsapp");
  const ADMIN = process.env.ADMIN_PHONE || "919816003322";

  let messageRefs;
  try {
    const res = await gmail.users.messages.list({ userId: "me", q: GMAIL_QUERY, maxResults: 20 });
    messageRefs = res.data.messages || [];
  } catch (e) {
    console.error("Gmail list error:", e.response?.data || e.message);
    return;
  }

  const processed = loadProcessedIds();
  const newRefs = messageRefs.filter((m) => !processed.has(m.id));

  for (const ref of newRefs) {
    processed.add(ref.id);
    try {
      const msgRes = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const headers = msgRes.data.payload?.headers || [];
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      if (!/google/i.test(from)) continue; // skip anything not actually from Google

      const body = decodeBody(msgRes.data.payload);
      const { reviewer, rating, comment } = parseReviewFromEmail(subject, body);
      const draftReply = draftReplyForRating(rating, reviewer.split(" ")[0] || "");
      const shortId = makeShortId(ref.id);
      const snippet = (msgRes.data.snippet || "").slice(0, 200);

      await sendMessage(ADMIN,
        `📩 *New Google Review (via email)* ${rating ? starsDisplay(rating) : "(rating unclear)"}\n\n` +
        (comment ? `"${comment}"\n` : `Raw email snippet: "${snippet}"\n`) +
        `— ${reviewer || "Guest"}\n\n` +
        `*Suggested reply:*\n"${draftReply}"\n\n` +
        `⚠️ Auto-posting isn't available yet (waiting on Google's Business Profile API approval) — copy this reply and paste it into the Business Profile app under this review.\n\n` +
        `Reference: ${shortId}`
      );
    } catch (e) { console.error("Review email process error:", e.response?.data || e.message); }
  }

  saveProcessedIds(processed);
}

module.exports = { checkReviewEmails };
