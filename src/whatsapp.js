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
    throw err;
  }
}

// ── BUTTON MESSAGE (max 3 buttons) ──────────────────────────────
// buttons = [{ id: 'btn_1', title: 'Housekeeping' }, ...]
async function sendButtonMessage(to, bodyText, buttons, headerText = null, footerText = null) {
  const toNum = to.replace(/^\+/, "");
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.log(`[MOCK BUTTONS] To: ${toNum}\n${bodyText}\nButtons: ${buttons.map(b=>b.title).join(' | ')}`);
    return;
  }
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toNum,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) }
        }))
      }
    }
  };
  if (headerText) payload.interactive.header = { type: "text", text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };
  try {
    const res = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`✓ Buttons sent to ${toNum}`);
    return res.data;
  } catch (err) {
    console.error(`✗ Failed buttons to ${toNum}:`, JSON.stringify(err.response?.data || err.message));
    // Fallback to text
    const txt = bodyText + '\n\n' + buttons.map((b,i) => `*${i+1}* - ${b.title}`).join('\n');
    return sendMessage(to, txt);
  }
}

// ── LIST MESSAGE (up to 10 items per section, multiple sections) ─
// sections = [{ title: 'Housekeeping', rows: [{ id: 'hk_1', title: 'Room cleaning', description: 'optional' }] }]
async function sendListMessage(to, bodyText, buttonLabel, sections, headerText = null, footerText = null) {
  const toNum = to.replace(/^\+/, "");
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.log(`[MOCK LIST] To: ${toNum}\n${bodyText}`);
    sections.forEach(s => s.rows.forEach(r => console.log(`  - ${r.title}`)));
    return;
  }
  // WhatsApp list: max 10 rows per section, max 5 sections
  const trimmedSections = sections.slice(0, 5).map(s => ({
    title: s.title.slice(0, 24),
    rows: s.rows.slice(0, 10).map(r => ({
      id: r.id.slice(0, 200),
      title: r.title.slice(0, 24),
      ...(r.description ? { description: r.description.slice(0, 72) } : {})
    }))
  }));

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toNum,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: trimmedSections
      }
    }
  };
  if (headerText) payload.interactive.header = { type: "text", text: headerText.slice(0, 60) };
  if (footerText) payload.interactive.footer = { text: footerText.slice(0, 60) };

  try {
    const res = await axios.post(
      `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`✓ List sent to ${toNum}`);
    return res.data;
  } catch (err) {
    console.error(`✗ Failed list to ${toNum}:`, JSON.stringify(err.response?.data || err.message));
    // Fallback to text
    let txt = bodyText + '\n\n';
    sections.forEach(s => { txt += `*${s.title}*\n`; s.rows.forEach((r,i) => { txt += `${i+1}. ${r.title}\n`; }); txt += '\n'; });
    return sendMessage(to, txt);
  }
}

// ── RATING BUTTONS ───────────────────────────────────────────────
async function sendRatingButtons(to, guestName) {
  return sendButtonMessage(
    to,
    `⭐ *How was your stay, ${guestName}?*\n\nWe'd love to hear your feedback!`,
    [
      { id: 'rating_5', title: '⭐⭐⭐⭐⭐ Excellent' },
      { id: 'rating_4', title: '⭐⭐⭐⭐ Good' },
      { id: 'rating_low', title: '⭐⭐⭐ or below' },
    ],
    null,
    'Tap to rate your experience'
  );
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
    throw err;
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

async function sendGuestCheckIn(to, { hotelName, guestName, room, checkout, plan, wifi }) {
  return sendTemplate(to, "guest_check_in", [hotelName || "Hotel", guestName || "Guest", room || "-", checkout || "-", plan || "-", wifi || "-"]);
}

async function sendHotelCheckin(to, { hotelName, guestName, room, checkout, plan, wifi }) {
  return sendTemplate(to, "hotel_checkin", [hotelName || "Hotel", guestName || "Guest", room || "-", checkout || "-", plan || "-", wifi || "-"]);
}

async function sendHotelCheckout(to, { guestName, hotelName, roomType, roomCharges, extraCharges, gst, total, reviewLink }) {
  return sendTemplate(to, "hotel_checkout", [
    guestName || "Guest",
    hotelName || "Hotel",
    roomType || "Room",
    Number(roomCharges || 0).toLocaleString("en-IN"),
    Number(extraCharges || 0).toLocaleString("en-IN"),
    Number(gst || 0).toLocaleString("en-IN"),
    Number(total || 0).toLocaleString("en-IN"),
    reviewLink || "-",
    hotelName || "Hotel"
  ]);
}

async function sendHelloWorld(to) {
  return sendTemplate(to, "hello_world");
}

async function sendReminder(to, text) {
  return sendMessage(to, text);
}

module.exports = {
  sendMessage, sendTemplate, sendReminder,
  sendEnquiryAck, sendRoomAvailable, sendNotAvailable, sendConfirmed, sendAskPlan,
  sendGuestCheckIn, sendHotelCheckin, sendHotelCheckout, sendHelloWorld,
  sendButtonMessage, sendListMessage, sendRatingButtons
};
