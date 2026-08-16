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

// Google Business Profile review notifications: from businessprofile-noreply@google.com
// with subject "<Name> left a review for <Business>". Scoped to recent mail so a first
// run doesn't blast every historical review.
const GMAIL_QUERY = 'from:businessprofile-noreply@google.com subject:"left a review" newer_than:3d';

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

// Strip the boilerplate (tracking links, standard footer copy) from the plain-text
// body so what's left is human-readable — used as a fallback in the WhatsApp message.
function cleanBody(body) {
  return body
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(Read review|Reply to review|Go to reviews)/i.test(l))
    .join("\n");
}

// Extracts from the real GBP notification format:
//   Subject: "<Name> left a review for <Business>"
//   Body:    "...you got a new <N>-star review..." and either the written review
//            text or "This user only left a rating".
function parseReviewFromEmail(subject, body) {
  const nameMatch = subject.match(/^(.+?) left a review for/i);
  const reviewer = nameMatch ? nameMatch[1].trim() : "";

  let rating = 0;
  const starMatch = body.match(/(\d)\s*-\s*star review/i) || subject.match(/(\d)\s*-\s*star/i);
  if (starMatch) rating = parseInt(starMatch[1], 10);

  let comment = "";
  const ratingOnly = /only left a rating/i.test(body);
  if (!ratingOnly) {
    // Text reviews put the comment between the "Read review" link and "Reply to review".
    const between = body.match(/Read review[\s\S]*?\n([\s\S]*?)Reply to review/i);
    if (between) {
      const lines = cleanBody(between[1])
        .split("\n")
        .filter((l) => !/^\S+\s*Star$/i.test(l)); // drop the "<name> Star" rating line
      comment = lines.slice(1).join(" ").trim().slice(0, 700); // skip the reviewer-name line
    }
  }

  return { reviewer, rating, comment, ratingOnly };
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
    try {
      const msgRes = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const headers = msgRes.data.payload?.headers || [];
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      if (!/google/i.test(from)) { processed.add(ref.id); continue; } // not from Google — won't ever notify, mark done

      const body = decodeBody(msgRes.data.payload);
      const { reviewer, rating, comment, ratingOnly } = parseReviewFromEmail(subject, body);
      const draftReply = draftReplyForRating(rating, reviewer.split(" ")[0] || "");
      const shortId = makeShortId(ref.id);

      let reviewLine;
      if (comment) reviewLine = `"${comment}"`;
      else if (ratingOnly) reviewLine = "_(rating only — no written comment)_";
      else reviewLine = `Couldn't read the text automatically. Email excerpt:\n${cleanBody(body).slice(0, 300)}`;

      await sendMessage(ADMIN,
        `📩 *New Google Review (via email)* ${rating ? starsDisplay(rating) : "(rating unclear)"}\n\n` +
        `${reviewLine}\n— ${reviewer || "Guest"}\n\n` +
        `*Suggested reply:*\n"${draftReply}"\n\n` +
        `⚠️ Auto-posting isn't available yet (waiting on Google's Business Profile API approval) — copy this reply and paste it into the Business Profile app under this review.\n\n` +
        `Reference: ${shortId}`
      );
      processed.add(ref.id); // mark done only after a successful notify, so failed sends retry next run
    } catch (e) { console.error("Review email process error:", e.response?.data || e.message); }
  }

  saveProcessedIds(processed);
}

module.exports = { checkReviewEmails };
