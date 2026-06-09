require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const { handleIncoming } = require("./handler");

// ── Webhook verification ───────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "hotel_bot_verify_123";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✓ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming messages ──────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return;
    const msg = messages[0];
    const from = msg.from;
    const msgType = msg.type;

    let text = "";
    let mediaId = null;

    if (msgType === "text") {
      text = msg.text?.body || "";
    } else if (msgType === "image") {
      mediaId = msg.image?.id || null;
      text = msg.image?.caption || "";
    } else {
      return; // ignore other types
    }

    console.log(`📨 From ${from} [${msgType}]: ${text}`);
    await handleIncoming({ from, text, msgId: msg.id, msgType, mediaId });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Hotel bot running ✓" }));

// -- POST /send-optin -- called by PMS when booking is created ----
app.post("/send-optin", async (req, res) => {
  try {
    const { 
      phone, guestName, hotelName, reservationId,
      room, checkout, plan, wifi 
    } = req.body;

    if (!phone || !guestName || !hotelName) {
      return res.status(400).json({ error: "phone, guestName, hotelName required" });
    }

    const { pendingOptIns } = require("./handler");
    const { sendMessage } = require("./whatsapp");

    pendingOptIns[phone] = {
      guestName, hotelName, reservationId,
      room: room || "Your room",
      checkout: checkout || "As per booking",
      plan: plan || "EP",
      wifi: wifi || "Ask reception",
      timestamp: Date.now()
    };

    const msg = 
      `Dear ${guestName},\n\n` +
      `Your booking at ${hotelName} is confirmed!\n\n` +
      `Reply *YES* to receive your check-in details and updates on WhatsApp.\n\n` +
      `Team ${hotelName}`;

    await sendMessage(phone, msg);
    res.json({ success: true, message: "Opt-in request sent to " + phone });
  } catch (err) {
    console.error("Opt-in error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-checkin -- called by PMS on check-in ---------------
app.post("/send-checkin", async (req, res) => {
  try {
    const { phone, guestName, hotelName, room, checkout, plan, wifi, hotelId } = req.body;
    const wa = require("./whatsapp");

    // Send check-in confirmation using approved template
    let sentTemplate = "hotel_checkin";
    try {
      await wa.sendGuestCheckIn(phone, { hotelName, guestName, room, checkout, plan, wifi });
      sentTemplate = "guest_check_in";
    } catch(e) {
      await wa.sendHotelCheckin(phone, { hotelName, guestName, room, checkout, plan, wifi });
    }

    // Register guest for service requests
    const { registerGuestForServices } = require("./guest-services");
    registerGuestForServices(phone, guestName, hotelName, room, checkout, hotelId);
    // Note: service menu is sent by PMS VPS after 30s (Render sleeps and loses setTimeout)

    res.json({ success: true, message: "Check-in message sent to " + phone, template: sentTemplate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-service-menu -- called by PMS VPS after 30s --------
app.post("/send-service-menu", async (req, res) => {
  try {
    const { phone, guestName, hotelName, reservationId } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const wa = require("./whatsapp");
    // Send approved template with buttons
    await wa.sendTemplate(phone, "guest_services_menu", [guestName || "Guest", hotelName || "Hotel"]);
    console.log(`✓ Service menu sent to ${phone}`);
    // Send portal link 3 seconds later
    if (reservationId) {
      setTimeout(async () => {
        try {
          const { sendMessage } = require("./whatsapp");
          await sendMessage(phone, `👉 *Order food, request housekeeping & more:*\nhttps://api.optisetup.in/guest/${reservationId}`);
        } catch(e) { console.log("Portal link error:", e.message); }
      }, 3000);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-checkout -- called by PMS on checkout ---------------
app.post("/send-checkout", async (req, res) => {
  try {
    const { phone, guestName, hotelName, roomCharges, gst, total, reviewLink } = req.body;
    const { sendMessage } = require("./whatsapp");

    const msg =
      `Dear ${guestName},\n\n` +
      `Thank you for staying at ${hotelName}! 🙏\n\n` +
      `Your bill summary:\n` +
      `Room charges: Rs.${roomCharges}\n` +
      `GST: Rs.${gst}\n` +
      `Total: Rs.${total}\n\n` +
      `We hope to see you again!\n\n` +
      (reviewLink ? `Please share your experience:\n${reviewLink}` : "");

    await sendMessage(phone, msg);
    res.json({ success: true, message: "Checkout message sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-precheckin -- called by PMS when booking is created ─
app.post("/send-precheckin", async (req, res) => {
  try {
    const { phone, guestName, hotelName, checkinDate, checkinLink } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName required" });
    const wa = require("./whatsapp");
    // Use approved booking_confirmation template
    // Variables: {{1}}=guestName, {{2}}=hotelName, {{3}}=checkinDate, {{4}}=checkinLink
    const result = await wa.sendTemplate(phone, "booking_confirmation", [
      guestName, hotelName || "Hotel", checkinDate, checkinLink
    ]);
    res.json({ success: true, message: "Booking confirmation sent to " + phone, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-staff-alert -- notify staff of guest orders --------
app.post("/send-staff-alert", async (req, res) => {
  try {
    const { message } = req.body;
    const { sendMessage } = require("./whatsapp");
    const staffPhone = process.env.HOD_FRONTDESK || '919816003322';
    await sendMessage(staffPhone, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

// ── DAILY MARKETING SMS — 10 AM IST ───────────────────────────
const cron = require("node-cron");
const axios = require("axios");

const SHEET_ID = "1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog";
const SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY || "AIzaSyCZbJjKgySFBC2hGvFvXkZTvnWZvwQz4pE";
const MARKETING_TEMPLATE = "sukhsagar_marketing_sms";

const fs = require("fs");
const SENT_NUMBERS_FILE = "./sent_marketing_numbers.json";

function loadSentNumbers() {
  try {
    if (fs.existsSync(SENT_NUMBERS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SENT_NUMBERS_FILE, "utf8")));
    }
  } catch(e) { console.error("Load sent numbers error:", e.message); }
  return new Set();
}

function saveSentNumbers(sentSet) {
  try {
    fs.writeFileSync(SENT_NUMBERS_FILE, JSON.stringify([...sentSet]), "utf8");
  } catch(e) { console.error("Save sent numbers error:", e.message); }
}

async function fetchAgentNumbers() {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/leads!E:E?key=${SHEETS_API_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
    const rows = res.data?.values || [];
    const numbers = rows
      .flat()
      .map(n => String(n).replace(/\D/g, ""))
      .filter(n => n.length >= 10 && n.length <= 13)
      .map(n => n.startsWith("91") ? n : "91" + n.slice(-10));
    return [...new Set(numbers)];
  } catch (err) {
    console.error("Google Sheets fetch error:", err.message);
    return [];
  }
}

async function sendMarketingSMS() {
  console.log("📣 Starting daily marketing SMS...");
  const allNumbers = await fetchAgentNumbers();
  if (!allNumbers.length) {
    console.log("No agent numbers found in sheet");
    return;
  }

  // Only send to numbers NOT already sent to
  const sentNumbers = loadSentNumbers();
  const newNumbers = allNumbers.filter(n => !sentNumbers.has(n));

  console.log(`📊 Total in sheet: ${allNumbers.length} | Already sent: ${sentNumbers.size} | New today: ${newNumbers.length}`);

  if (!newNumbers.length) {
    console.log("No new numbers to send today — all already received the message");
    return;
  }

  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_ACCESS_TOKEN;
  let sent = 0, failed = 0;

  for (const number of newNumbers) {
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: number,
          type: "template",
          template: {
            name: MARKETING_TEMPLATE,
            language: { code: "en" },
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: {
                      id: "1567521214956263"
                    }
                  }
                ]
              }
            ]
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );
      sentNumbers.add(number); // Mark as sent
      sent++;
      console.log(`✓ Marketing SMS sent to ${number} (${sent}/${newNumbers.length})`);
      await new Promise(r => setTimeout(r, 500)); // avoid rate limiting
    } catch (err) {
      failed++;
      console.error(`✗ Failed to send to ${number}:`, err.response?.data?.error?.message || err.message);
    }
  }

  // Save updated sent list
  saveSentNumbers(sentNumbers);
  console.log(`📣 Done: ${sent} sent, ${failed} failed. Total ever sent: ${sentNumbers.size}`);
}

// Run at 10:00 AM IST (04:30 UTC) every day
cron.schedule("30 4 * * *", sendMarketingSMS, { timezone: "Asia/Kolkata" });
console.log("📣 Daily marketing SMS scheduled at 10:00 AM IST");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "hotelease2026";
function checkAdmin(req, res) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_SECRET) { res.status(403).json({ error: "Unauthorized" }); return false; }
  return true;
}

// GET — open in browser to send now
app.get("/send-marketing-now", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ success: true, message: "Marketing SMS started — check Render logs" });
  sendMarketingSMS();
});

// GET — check status in browser
app.get("/marketing-status", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const sent = loadSentNumbers();
  res.json({ totalSent: sent.size, numbers: [...sent] });
});

// GET — reset in browser
app.get("/marketing-reset", (req, res) => {
  if (!checkAdmin(req, res)) return;
  saveSentNumbers(new Set());
  res.json({ success: true, message: "Sent list cleared — all numbers will receive next run" });
});

// ── AC STATUS REMINDER — every 2 hours ─────────────────────────
const AC_REMINDER_PHONE = "918627038322";
const AC_TEMPLATE_NAME = "ac_status_reminder";

async function sendACReminder() {
  try {
    const phoneId = process.env.WA_PHONE_NUMBER_ID;
    const token = process.env.WA_ACCESS_TOKEN;
    if (!phoneId || !token) { console.log("AC reminder: WA credentials not set"); return; }

    // Try plain text first
    try {
      const res = await axios.post(
        `https://graph.facebook.com/v25.0/${phoneId}/messages`,
        { messaging_product: "whatsapp", recipient_type: "individual", to: AC_REMINDER_PHONE,
          type: "text", text: { body: "Kindly update AC status on group 🙏" } },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
      console.log(`✓ AC reminder sent:`, res.data?.messages?.[0]?.id);
    } catch(textErr) {
      // Fallback to template
      const res = await axios.post(
        `https://graph.facebook.com/v25.0/${phoneId}/messages`,
        { messaging_product: "whatsapp", recipient_type: "individual", to: AC_REMINDER_PHONE,
          type: "template", template: { name: AC_TEMPLATE_NAME, language: { code: "en" } } },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
      console.log(`✓ AC reminder (template) sent:`, res.data?.messages?.[0]?.id);
    }
  } catch (err) {
    console.error("✗ AC reminder error:", err.response?.data || err.message);
  }
}

setInterval(sendACReminder, 2 * 60 * 60 * 1000);
setTimeout(sendACReminder, 10000);
console.log("⏰ AC status reminder scheduled every 2 hours to " + AC_REMINDER_PHONE);
