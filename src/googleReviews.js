const axios = require("axios");
const fs = require("fs");
const { google } = require("googleapis");
const { draftReplyForRating, starsDisplay } = require("./reviewReplyTemplates");

const CLIENT_ID = process.env.GOOGLE_GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_GBP_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_GBP_REFRESH_TOKEN;
const ACCOUNT_ID = process.env.GOOGLE_GBP_ACCOUNT_ID;
const LOCATION_ID = process.env.GOOGLE_GBP_LOCATION_ID;

const SEEN_REVIEWS_FILE = "./seen_reviews.json";
const PENDING_DRAFTS_FILE = "./pending_review_drafts.json";

function getOAuthClient() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return null;
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return client;
}

async function getAccessToken() {
  const client = getOAuthClient();
  if (!client) throw new Error("Google Business Profile OAuth credentials not configured");
  const { token } = await client.getAccessToken();
  return token;
}

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error(`Load ${file} error:`, e.message); }
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error(`Save ${file} error:`, e.message); }
}

function loadSeenReviewIds() { return new Set(loadJSON(SEEN_REVIEWS_FILE, [])); }
function saveSeenReviewIds(set) { saveJSON(SEEN_REVIEWS_FILE, [...set]); }

// shortId -> { reviewName, reviewer, rating, comment, draftReply }
function loadPendingDrafts() { return loadJSON(PENDING_DRAFTS_FILE, {}); }
function savePendingDrafts(drafts) { saveJSON(PENDING_DRAFTS_FILE, drafts); }

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function fetchReviews() {
  const token = await getAccessToken();
  const url = `https://mybusiness.googleapis.com/v4/accounts/${ACCOUNT_ID}/locations/${LOCATION_ID}/reviews`;
  // Most-recent first, one page — new reviews always land at the top, so we never
  // need to page through the whole history to spot them.
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: { orderBy: "updateTime desc", pageSize: 50 },
  });
  return res.data?.reviews || [];
}

async function postReply(reviewName, comment) {
  const token = await getAccessToken();
  const url = `https://mybusiness.googleapis.com/v4/${reviewName}/reply`;
  await axios.put(url, { comment }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
}

function draftReplyFor(review) {
  const rating = STAR_MAP[review.starRating] || 0;
  const name = review.reviewer?.displayName?.split(" ")[0] || "";
  return draftReplyForRating(rating, name);
}

function makeShortId(reviewId) {
  return "R" + reviewId.replace(/\D/g, "").slice(-4).padStart(4, "0");
}

async function checkForNewReviews() {
  if (!getOAuthClient() || !ACCOUNT_ID || !LOCATION_ID) {
    console.log("Google review check skipped — GBP credentials not configured");
    return;
  }
  const { sendMessage } = require("./whatsapp");
  const ADMIN = process.env.ADMIN_PHONE || "919816003322";

  let reviews;
  try {
    reviews = await fetchReviews();
  } catch (e) {
    console.error("Fetch reviews error:", e.response?.data || e.message);
    return;
  }

  // First run: mark every existing review as seen without notifying, so only
  // reviews that arrive from here on trigger an alert.
  const firstRun = !fs.existsSync(SEEN_REVIEWS_FILE);
  const seen = loadSeenReviewIds();
  if (firstRun) {
    reviews.forEach((r) => seen.add(r.reviewId));
    saveSeenReviewIds(seen);
    console.log(`⭐ Seeded ${seen.size} existing Google reviews — future reviews will notify.`);
    return;
  }

  const drafts = loadPendingDrafts();
  const newReviews = reviews.filter((r) => !seen.has(r.reviewId));

  for (const review of newReviews) {
    seen.add(review.reviewId);
    if (review.reviewReply) continue; // already replied on Google directly, nothing to draft

    const shortId = makeShortId(review.reviewId);
    const draftReply = draftReplyFor(review);
    const rating = STAR_MAP[review.starRating] || 0;
    drafts[shortId] = {
      reviewName: review.name,
      reviewer: review.reviewer?.displayName || "Guest",
      rating,
      comment: review.comment || "",
      draftReply,
    };

    try {
      await sendMessage(ADMIN,
        `📩 *New Google Review* ${starsDisplay(rating)}\n\n` +
        `"${review.comment || "(no written comment)"}"\n— ${review.reviewer?.displayName || "Guest"}\n\n` +
        `*Suggested reply:*\n"${draftReply}"\n\n` +
        `Reply *OK* to post this reply to Google, *REVIEW EDIT ${shortId} <text>* to change it, or *REVIEW SKIP ${shortId}* to skip.\n` +
        `_(ref ${shortId} — if more than one is pending, use *OK ${shortId}*)_`
      );
    } catch (e) { console.error("Review admin notify error:", e.message); }
  }

  saveSeenReviewIds(seen);
  savePendingDrafts(drafts);
}

async function approveReply(shortId) {
  const drafts = loadPendingDrafts();
  const draft = drafts[shortId];
  if (!draft) return { success: false, message: `No pending review found for ${shortId}` };
  await postReply(draft.reviewName, draft.draftReply);
  delete drafts[shortId];
  savePendingDrafts(drafts);
  return { success: true, message: `✅ Reply posted for ${shortId} (${draft.reviewer})` };
}

async function editAndPostReply(shortId, customText) {
  const drafts = loadPendingDrafts();
  const draft = drafts[shortId];
  if (!draft) return { success: false, message: `No pending review found for ${shortId}` };
  await postReply(draft.reviewName, customText);
  delete drafts[shortId];
  savePendingDrafts(drafts);
  return { success: true, message: `✅ Custom reply posted for ${shortId} (${draft.reviewer})` };
}

function skipReview(shortId) {
  const drafts = loadPendingDrafts();
  const draft = drafts[shortId];
  if (!draft) return { success: false, message: `No pending review found for ${shortId}` };
  delete drafts[shortId];
  savePendingDrafts(drafts);
  return { success: true, message: `⏭️ Skipped review ${shortId} (${draft.reviewer}) — no reply posted` };
}

// Handles a plain "OK" (or "OK R1234") approval. Returns { handled:false } when
// there are no pending drafts, so the caller can let other admin commands run.
async function approveByOk(shortId) {
  const drafts = loadPendingDrafts();
  const ids = Object.keys(drafts);
  if (!ids.length) return { handled: false };
  if (shortId && drafts[shortId]) return { handled: true, ...(await approveReply(shortId)) };
  if (!shortId && ids.length === 1) return { handled: true, ...(await approveReply(ids[0])) };
  return {
    handled: true, success: false,
    message: shortId
      ? `No pending review found for ${shortId}. Pending: ${ids.join(", ")}`
      : `Multiple reviews pending (${ids.join(", ")}). Reply *OK <ref>*, e.g. OK ${ids[0]}`,
  };
}

function listPendingDrafts() {
  const drafts = loadPendingDrafts();
  const ids = Object.keys(drafts);
  if (!ids.length) return "📋 No pending review replies.";
  return `📋 *Pending Review Replies (${ids.length}):*\n\n` +
    ids.map((id) => `*${id}* — ${starsDisplay(drafts[id].rating)} — ${drafts[id].reviewer}`).join("\n");
}

module.exports = {
  checkForNewReviews, approveReply, editAndPostReply, skipReview, listPendingDrafts, approveByOk,
};
