const axios = require("axios");

const BASE_URL = "https://graph.facebook.com/v25.0";
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

async function sendMessage(to, text) {
  const toNum = to.replace(/^\+/, "");
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.log(`[MOCK] To: ${toNum}\n${text}`);
    return;
  }
  try {
    const res = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to: toNum, type: "text", text: { body: text, preview_url: false } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`✓ Text sent to ${toNum}`);
    return res.data;
  } catch (err) {
    console.error(`✗ Failed to send to ${toNum}:`, JSON.stringify(err.response?.data || err.message));
  }
}

async function sendTemplate(to, templateName, params = []) {
  const toNum = to.replace(/^\+/, "");
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.log(`[MOCK TEMPLATE] To: ${toNum} | ${templateName} | Params:`, params);
    return;
  }
  const components = params.length > 0 ? [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }] : [];
  try {
    const res = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to: toNum, type: "template", template: { name: templateName, language: { code: "en" }, components } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`✓ Template "${templateName}" sent to ${toNum}`);
    return res.data;
  } catch (err) {
    console.error(`✗ Failed template "${templateName}" to ${toNum}:`, JSON.stringify(err.response?.data || err.message));
  }
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  try { return new Date(dateStr).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return dateStr; }
}

function calcNights(ci, co) {
  if (!ci || !co) return 0;
  return Math.max(0, Math.round((new Date(co) - new Date(ci)) / 86400000));
}

async function sendEnquiryAck(to, { ciDate, coDate, rooms, plan }) {
  return sendTemplate(to, "hotel_enquiry_ack", [fmtDate(ciDate), fmtDate(coDate), String(rooms), plan || "—"]);
}

async function sendRoomAvailable(to, { ciDate, coDate, rooms, plan, rate }) {
  const nights = calcNights(ciDate, coDate);
  return sendTemplate(to, "hotel_room_available", [fmtDate(ciDate), fmtDate(coDate), String(rooms), plan || "—", rate ? `Rs ${rate}` : "On request", String(nights)]);
}

async function sendNotAvailable(to, { ciDate, coDate, rooms, plan }) {
  return sendTemplate(to, "hotel_not_available", [fmtDate(ciDate), fmtDate(coDate), String(rooms), plan || "—"]);
}

async function sendConfirmed(to, { ciDate, coDate, rooms, plan, rate, confirmationNumber }) {
  const cnf = confirmationNumber || "CNF" + Date.now().toString().slice(-8);
  return sendTemplate(to, "hotel_confirmed", [fmtDate(ciDate), fmtDate(coDate), String(rooms), plan || "—", rate ? `Rs ${rate}` : "On request", cnf]);
}

async function sendAskPlan(to, { ciDate, coDate, rooms }) {
  return sendTemplate(to, "hotel_ask_plan", [fmtDate(ciDate), fmtDate(coDate), String(rooms)]);
}

async function sendReminder(to, text) {
  return sendMessage(to, text);
}

module.exports = { sendMessage, sendTemplate, sendReminder, sendEnquiryAck, sendRoomAvailable, sendNotAvailable, sendConfirmed, sendAskPlan };
