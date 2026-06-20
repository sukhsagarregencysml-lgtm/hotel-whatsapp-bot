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
    let buttonId = null;

    if (msgType === "text") {
      text = msg.text?.body || "";
    } else if (msgType === "image") {
      mediaId = msg.image?.id || null;
      text = msg.image?.caption || "";
    } else if (msgType === "interactive") {
      const interactive = msg.interactive;
      if (interactive?.type === "button_reply") {
        buttonId = interactive.button_reply?.id || null;
        text = interactive.button_reply?.title || "";
      } else if (interactive?.type === "list_reply") {
        buttonId = interactive.list_reply?.id || null;
        text = interactive.list_reply?.title || "";
      } else {
        return;
      }
    } else {
      return; // ignore other types
    }

    console.log(`📨 From ${from} [${msgType}]: ${text}${buttonId ? ` (button: ${buttonId})` : ""}`);
    await handleIncoming({ from, text, msgId: msg.id, msgType, mediaId, buttonId });
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
    const { sendTemplate } = require("./whatsapp");

    pendingOptIns[phone] = {
      guestName, hotelName, reservationId,
      room: room || "Your room",
      checkout: checkout || "As per booking",
      plan: plan || "EP",
      wifi: wifi || "Ask reception",
      timestamp: Date.now()
    };

    await sendTemplate(phone, "booking_confirmation", [guestName, hotelName, checkout || "As per booking", reservationId || "—"]);
    res.json({ success: true, message: "Booking confirmation sent to " + phone });
  } catch (err) {
    console.error("Opt-in error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-precheckin -- called by PMS after booking to send portal link --
app.post("/send-precheckin", async (req, res) => {
  try {
    const { phone, guestName, hotelName, checkinDate, checkinLink } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName required" });
    const { sendTemplate } = require("./whatsapp");
    // Use booking_confirmation template: guestName, hotelName, checkinDate, portalLink
    await sendTemplate(phone, "booking_confirmation", [guestName, hotelName, checkinDate || "As per booking", checkinLink || "https://api.optisetup.in/guest-portal.html"]);
    res.json({ success: true, message: "Pre check-in link sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-service-menu -- sent 45s after check-in with guest portal link --
app.post("/send-service-menu", async (req, res) => {
  try {
    const { phone, guestName, hotelName, reservationId } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const { sendTemplate } = require("./whatsapp");
    await sendTemplate(phone, "guest_services_menu", [guestName || "Guest"]);
    // Send portal link via template (plain text won't deliver without 24h window)
    if (reservationId) {
      const portalLink = `https://api.optisetup.in/portal/${reservationId}`;
      await sendTemplate(phone, "booking_confirmation", [guestName || "Guest", hotelName || "Hotel", "your stay", portalLink]);
    }
    res.json({ success: true, message: "Service menu sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-checkin -- called by PMS on check-in ---------------
app.post("/send-checkin", async (req, res) => {
  try {
    const { phone, guestName, hotelName, room, checkout, plan, wifi } = req.body;
    const { sendHotelCheckin } = require("./whatsapp");

    await sendHotelCheckin(phone, { hotelName, guestName, room, checkout, plan, wifi });
    res.json({ success: true, message: "Check-in message sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-checkout -- called by PMS on checkout ---------------
app.post("/send-checkout", async (req, res) => {
  try {
    const { phone, guestName, hotelName, bookingId, checkinDate, checkoutDate, roomType, roomsCount, plan, total } = req.body;
    const { sendHotelCheckout } = require("./whatsapp");

    await sendHotelCheckout(phone, { guestName, hotelName, bookingId, checkinDate, checkoutDate, roomType, roomsCount, plan, total });
    res.json({ success: true, message: "Checkout message sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-review-request -- called by PMS after checkout to ask for a rating --
app.post("/send-review-request", async (req, res) => {
  try {
    const { phone, guestName, hotelName, room, reviewLink, adminPhone } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName required" });
    const { sendRatingButtons } = require("./whatsapp");
    const { pendingReviews } = require("./handler");

    pendingReviews[phone] = {
      guestName, hotelName: hotelName || "our hotel", room,
      reviewLink, adminPhone, awaitingIssue: false, timestamp: Date.now()
    };

    await sendRatingButtons(phone, guestName);
    res.json({ success: true, message: "Review request sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-restaurant-bill -- called by PMS on checkout if guest ordered food --
app.post("/send-restaurant-bill", async (req, res) => {
  try {
    const { phone, guestName, room, hotelName, items, total, billNo } = req.body;
    if (!phone || !items || !items.length) return res.status(400).json({ error: "phone and items required" });

    const { generateRestaurantBill } = require("./generate-restaurant-bill");
    const axios = require("axios");
    const fs = require("fs");
    const FormData = require("form-data");

    const bill = billNo || "ZB" + Date.now().toString().slice(-8);
    const date = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    console.log(`[ZAIKA BILL] Generating PDF for ${phone} | Items: ${items.length} | Total: ${total}`);
    const pdfPath = await generateRestaurantBill({
      billNo: bill, date, guestName: guestName || "Guest", room: room || "-",
      hotelName, items, total
    });
    console.log(`[ZAIKA BILL] PDF generated at ${pdfPath}`);

    const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
    const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
      console.log(`[MOCK RESTAURANT BILL] To: ${phone} | Bill: ${bill} | Total: ${total}`);
      return res.json({ success: true, message: "Mock restaurant bill (no WA credentials)" });
    }

    // Upload PDF to WhatsApp media
    const uploadForm = new FormData();
    uploadForm.append("messaging_product", "whatsapp");
    uploadForm.append("type", "application/pdf");
    uploadForm.append("file", fs.createReadStream(pdfPath), {
      contentType: "application/pdf",
      filename: `Zaika-Bill-${bill}.pdf`,
      knownLength: fs.statSync(pdfPath).size
    });

    console.log(`[ZAIKA BILL] Uploading PDF to WhatsApp media API...`);
    let uploadRes;
    try {
      uploadRes = await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/media`,
        uploadForm,
        {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...uploadForm.getHeaders() },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );
    } catch (uploadErr) {
      const detail = JSON.stringify(uploadErr.response?.data || uploadErr.message);
      console.error(`[ZAIKA BILL] Media upload failed:`, detail);
      return res.status(500).json({ error: "Media upload failed", detail });
    }

    const mediaId = uploadRes.data?.id;
    if (!mediaId) {
      console.error(`[ZAIKA BILL] No media id in upload response:`, JSON.stringify(uploadRes.data));
      return res.status(500).json({ error: "Media upload failed — no media id returned", detail: uploadRes.data });
    }
    console.log(`[ZAIKA BILL] Media uploaded, id: ${mediaId}`);

    const toNum = phone.replace(/^\+/, "");

    // Step 1: Send the approved template (body-only, no header) — this works outside 24h window
    let tplRes;
    try {
      tplRes = await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toNum,
          type: "template",
          template: {
            name: "zaika_bill_ready",
            language: { code: "en" },
            components: [
              { type: "body", parameters: [
                { type: "text", text: String(guestName || "Guest") },
                { type: "text", text: String(room || "-") },
                { type: "text", text: Number(total || 0).toLocaleString("en-IN") }
              ] }
            ]
          }
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
    } catch (tplErr) {
      const detail = JSON.stringify(tplErr.response?.data || tplErr.message);
      console.error(`[ZAIKA BILL] Template send failed:`, detail);
      return res.status(500).json({ error: "Template send failed", detail });
    }
    console.log(`[ZAIKA BILL] Template sent to ${toNum}:`, tplRes.data?.messages?.[0]?.id);

    // Step 2: Send the PDF as a document message immediately after (opens a session window via template reply)
    try {
      const docRes = await axios.post(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toNum,
          type: "document",
          document: {
            id: mediaId,
            filename: `Zaika-Bill-${bill}.pdf`,
            caption: "Zaika Restaurant — Food Bill"
          }
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[ZAIKA BILL] PDF document sent to ${toNum}:`, docRes.data?.messages?.[0]?.id);
    } catch (docErr) {
      // Non-fatal — template already sent; document may fail if outside 24h window
      console.error(`[ZAIKA BILL] PDF document send failed (non-fatal):`, JSON.stringify(docErr.response?.data || docErr.message));
    }

    console.log(`✓ Restaurant bill sent to ${phone}`);
    res.json({ success: true, message: "Restaurant bill sent to " + phone, messageId: tplRes.data?.messages?.[0]?.id });
  } catch (err) {
    console.error("Restaurant bill error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message, detail: err.response?.data });
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
    // Use public CSV export — no OAuth needed, just make sheet public
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=leads&range=E:E`;
    const res = await axios.get(csvUrl, { timeout: 15000 });
    const rows = res.data.split("\n");
    const numbers = rows
      .map(r => r.replace(/"/g, "").trim())
      .map(n => String(n).replace(/\D/g, ""))
      .filter(n => n.length >= 10 && n.length <= 13)
      .map(n => n.startsWith("91") ? n : "91" + n.slice(-10));
    const unique = [...new Set(numbers)];
    console.log(`📋 Fetched ${unique.length} numbers from sheet`);
    return unique;
  } catch (err) {
    console.error("Google Sheets fetch error:", err.message);
    // Fallback to API key method
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/leads!E:E?key=${SHEETS_API_KEY}`;
      const res2 = await axios.get(url, { timeout: 10000 });
      const rows = res2.data?.values || [];
      const numbers = rows
        .flat()
        .map(n => String(n).replace(/\D/g, ""))
        .filter(n => n.length >= 10 && n.length <= 13)
        .map(n => n.startsWith("91") ? n : "91" + n.slice(-10));
      return [...new Set(numbers)];
    } catch(err2) {
      console.error("Fallback fetch also failed:", err2.message);
      return [];
    }
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

      // Auto-add to agents list as "Marketing Lead" category C
      try {
        const agentsModule = require("./agents");
        if (agentsModule.getAgent && agentsModule.addAgent) {
          const existing = await agentsModule.getAgent(number);
          if (!existing) {
            await agentsModule.addAgent(number, "Marketing Lead", "C");
            console.log(`📋 Added ${number} to agent list`);
          }
        }
      } catch(agentErr) { /* silent */ }

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

// Check pending enquiry summaries every 10 minutes
cron.schedule("*/10 * * * *", async () => {
  try {
    const tracker = global.enquiryTracker;
    if (!tracker) return;
    const { sendMessage } = require("./whatsapp");
    const { getAgent } = require("./handler");
    const ADMIN = process.env.ADMIN_PHONE || "919816003322";
    const now = Date.now();

    for (const [phone, info] of Object.entries(tracker)) {
      // If last activity was 10+ mins ago
      const lastActivity = info.lastActivityTime || info.startTime;
      if (now - lastActivity >= 10 * 60 * 1000) {
        try {
          const duration = Math.round((now - info.startTime) / 60000);
          const msgLog = (info.msgs || []).slice(0, 3).join(" | ").slice(0, 120);
          const status = info.booked
            ? "✅ BOOKED — Voucher: " + (info.voucherNo || "Confirmed")
            : "❌ NOT BOOKED";
          await sendMessage(ADMIN,
            "📊 *ENQUIRY SUMMARY*\n" +
            "👤 " + phone + "\n" +
            "💬 " + msgLog + "\n" +
            "⏱ " + duration + " min | " + status
          );
          delete tracker[phone];
          console.log("Enquiry summary sent for", phone);
        } catch(e) { console.error("Summary cron error:", e.message); }
      }
    }
  } catch(e) { console.error("Enquiry cron error:", e.message); }
}, { timezone: "Asia/Kolkata" });
console.log("📣 Daily marketing SMS scheduled at 10:00 AM IST");

// Manual trigger endpoint
app.post("/send-marketing", async (req, res) => {
  res.json({ success: true, message: "Marketing SMS started" });
  await sendMarketingSMS();
});

// Check status endpoint
app.get("/marketing-status", (req, res) => {
  const sent = loadSentNumbers();
  res.json({ totalSent: sent.size, numbers: [...sent] });
});

// Reset sent list (if you want to resend to everyone)
app.post("/marketing-reset", (req, res) => {
  saveSentNumbers(new Set());
  res.json({ success: true, message: "Sent list cleared — will send to all numbers tomorrow" });
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
