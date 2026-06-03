const axios = require("axios");

const PMS_URL = process.env.PMS_URL || "https://api.optisetup.in";
const CHAT_SECRET = process.env.CHAT_WEBHOOK_SECRET || process.env.STAYEZEE_API_KEY || "";

function cleanPhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

async function syncChatMessage(payload) {
  const phone = cleanPhone(payload.phone);
  if (!phone || !PMS_URL) return;
  try {
    await axios.post(
      `${PMS_URL.replace(/\/$/, "")}/api/whatsapp/ingest`,
      { ...payload, phone },
      { headers: CHAT_SECRET ? { "x-chat-secret": CHAT_SECRET } : {} }
    );
  } catch (err) {
    console.log("Chat sync skipped:", err.response?.data?.error || err.message);
  }
}

module.exports = { syncChatMessage, cleanPhone };
