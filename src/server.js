require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const auth = (req, res, next) => {
  const apiKey = process.env.STAYEZEE_API_KEY;
  if (apiKey && req.headers["x-api-key"] !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const { handleIncoming } = require("./handler");
const { registerGuestForServices, sendServiceMenu, startFeedback, guestRoomMap } = require("./guest-services");
const { syncChatMessage } = require("./chat-sync");

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
    const contextMsgId = msg.context?.id || null;

    if (msgType === "text") {
      text = msg.text?.body || "";
    } else if (msgType === "image") {
      mediaId = msg.image?.id || null;
      text = msg.image?.caption || "";
    } else if (msgType === "interactive") {
      if (msg.interactive?.type === "button_reply") {
        buttonId = msg.interactive.button_reply?.id;
        text = msg.interactive.button_reply?.title || "";
      } else if (msg.interactive?.type === "list_reply") {
        buttonId = msg.interactive.list_reply?.id;
        text = msg.interactive.list_reply?.title || "";
      }
    } else {
      return;
    }

    console.log(`📨 From ${from} [${msgType}]: ${text}${buttonId ? " [btn:"+buttonId+"]" : ""}`);
    const guest = guestRoomMap[from] || {};
    await syncChatMessage({
      hotelId: guest.hotelId,
      phone: from,
      guestName: guest.guestName,
      roomNumber: guest.roomNumber,
      direction: "inbound",
      sender: "guest",
      messageType: msgType,
      message: text || buttonId || msgType,
      waMessageId: msg.id,
      meta: { buttonId, mediaId, contextMsgId }
    });
    await handleIncoming({ from, text, msgId: msg.id, msgType, mediaId, contextMsgId, buttonId });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── Bot tasks proxy (for Chats page) ───────────────────────────
app.get('/api/bot/tasks', auth, async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const https = require('https');
      https.get('https://hotel-whatsapp-bot-2ole.onrender.com/active-tasks', r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    res.json(result);
  } catch(err) {
    res.json({ success: true, tasks: [] });
  }
});

// ── Send WhatsApp message proxy ─────────────────────────────────
app.post('/api/whatsapp/send', auth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    const https = require('https');
    const payload = JSON.stringify({ to: phone, message });
    const r = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'hotel-whatsapp-bot-2ole.onrender.com',
        port: 443, path: '/send-message', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); });
      req2.on('error', reject);
      req2.write(payload); req2.end();
    });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-message', async (req, res) => {
  const apiKey = process.env.STAYEZEE_API_KEY;
  if (apiKey && req.headers["x-api-key"] !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { phone, to, message, text, hotelId, sender } = req.body;
    const target = phone || to;
    const body = message || text;
    if (!target || !body) return res.status(400).json({ error: "phone and message are required" });
    const { sendMessage } = require("./whatsapp");
    const result = await sendMessage(target, body, { skipSync: true, hotelId, sender: sender || "staff" });
    res.json({ success: true, message: "Message sent to " + target, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});


// ── Feedback summary (for PMS Business Overview) ────────────────
app.get("/feedback-summary", async (req, res) => {
  const { feedbackSessions } = require("./guest-services");
  // Return stored feedback history
  const feedbacks = global.feedbackHistory || [];
  const avg = feedbacks.length > 0
    ? feedbacks.reduce((s,f) => s + f.rating, 0) / feedbacks.length
    : 0;
  res.json({ success: true, feedbacks, avgRating: avg.toFixed(1), total: feedbacks.length });
});

// ── Tasks history (completed tasks log) ─────────────────────────
app.get("/tasks-history", async (req, res) => {
  const history = global.tasksHistory || [];
  res.json({ success: true, tasks: history });
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
  // Optional API key auth — set STAYEZEE_API_KEY in .env to enable
  const apiKey = process.env.STAYEZEE_API_KEY;
  if (apiKey && req.headers["x-api-key"] !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { hotelId, phone, guestName, hotelName, room, checkout, plan, wifi } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName are required" });
    const templateName = process.env.WA_CHECKIN_TEMPLATE || "guest_check_in";
    const wa = require("./whatsapp");
    const values = { hotelName, guestName, room, checkout, plan, wifi };
    let sentTemplate = templateName;
    let result;
    try {
      result = templateName === "hotel_checkin"
        ? await wa.sendHotelCheckin(phone, values)
        : templateName === "guest_check_in"
          ? await wa.sendGuestCheckIn(phone, values)
          : await wa.sendTemplate(phone, templateName, [hotelName || "Hotel", guestName, room || "-", checkout || "-", plan || "-", wifi || "-"]);
    } catch (templateErr) {
      if (templateName !== "guest_check_in") throw templateErr;
      console.log("guest_check_in failed, trying hotel_checkin:", templateErr.response?.data?.error?.message || templateErr.message);
      sentTemplate = "hotel_checkin";
      result = await wa.sendHotelCheckin(phone, values);
    }

    // Register guest for WhatsApp service requests
    registerGuestForServices(phone, guestName, hotelName, room, checkout, hotelId);

    // Send a text nudge 30 seconds after check-in (guest must reply first to open 24hr window)
    setTimeout(async () => {
      try {
        const wa = require("./whatsapp");
        await wa.sendMessage(phone,
          `🏨 *Sukhsagar Nature Resort* — Guest Services\n\nDear *${guestName}*, we're here to help anytime!\n\nReply *HI* to access:\n🛏 Housekeeping\n🍽 Room Dining\n🔧 Maintenance\n📞 Front Desk\n\nOr just type your request 😊`
        );
        console.log(`✓ Service nudge sent to ${phone}`);
      } catch(e) { console.log("Service nudge error:", e.message); }
    }, 30000);

    res.json({ success: true, message: "Check-in template sent to " + phone, template: sentTemplate, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// -- POST /send-checkout -- called by PMS on checkout ---------------
app.post("/send-checkout", async (req, res) => {
  // Optional API key auth — set STAYEZEE_API_KEY in .env to enable
  const apiKey = process.env.STAYEZEE_API_KEY;
  if (apiKey && req.headers["x-api-key"] !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { phone, guestName, hotelName, roomType, roomCharges, extraCharges, gst, total, reviewLink } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName are required" });
    const templateName = process.env.WA_CHECKOUT_TEMPLATE || "hotel_checkout";
    const wa = require("./whatsapp");
    const result = templateName === "hotel_checkout"
      ? await wa.sendHotelCheckout(phone, { guestName, hotelName, roomType, roomCharges, extraCharges, gst, total, reviewLink })
      : await wa.sendTemplate(phone, templateName, [
          guestName,
          hotelName || "Hotel",
          roomType || "Room",
          Number(roomCharges || 0).toLocaleString("en-IN"),
          Number(extraCharges || 0).toLocaleString("en-IN"),
          Number(gst || 0).toLocaleString("en-IN"),
          Number(total || 0).toLocaleString("en-IN"),
          reviewLink || "-",
          hotelName || "Hotel"
        ]);

    // Send feedback/rating request 2 minutes after checkout message
    setTimeout(async () => {
      try {
        const wa = require("./whatsapp");
        await startFeedback(phone, guestName, wa);
      } catch(e) { console.log("Feedback error:", e.message); }
    }, 2 * 60 * 1000);

    res.json({ success: true, message: "Checkout template sent to " + phone, template: templateName, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

// ── DAILY PAYMENT REMINDER CHECK — every day at 9 AM ─────────
const cron = require("node-cron");

cron.schedule("0 9 * * *", async () => {
  try {
    const { pendingPayments } = require("./handler");
    const axios = require("axios");
    const today = new Date().toISOString().split("T")[0];
    const UPI_ID = process.env.UPI_ID || "9816003322@okbizaxis";

    for (const [phone, pending] of Object.entries(pendingPayments)) {
      // Check if 2nd payment reminder is due today
      if (
        pending.secondPaymentReminderDate &&
        pending.secondPaymentReminderDate <= today &&
        pending.paymentStep === 1
      ) {
        try {
          const secondAmt = pending.secondPaymentAmount || Math.round((pending.total || 0) * 0.35);
          const upiLink2 = `upi://pay?pa=${UPI_ID}&pn=Hotel%20Sukhsagar%20Regency&am=${secondAmt}&cu=INR&tn=2nd-${pending.voucherNo}`;
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&ecc=H&margin=2&data=${encodeURIComponent(upiLink2)}`;

          await axios.post(
            `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: phone,
              type: "image",
              image: {
                link: qrUrl,
                caption:
                  `⏰ *2ND PAYMENT DUE*\n\n` +
                  `Voucher: *${pending.voucherNo}*\n` +
                  `Guest: ${pending.guestName}\n` +
                  `Check-in: *${pending.ciDate}* is in 15 days!\n\n` +
                  `2nd Payment (35%): *Rs.${secondAmt.toLocaleString()}*\n` +
                  `UPI ID: *${UPI_ID}*\n\n` +
                  `📸 Please pay and send screenshot.`
              }
            },
            { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
          );

          // Notify admin
          const { sendReminder } = require("./whatsapp");
          await sendReminder(process.env.ADMIN_PHONE || "919816003322",
            `⏰ *2ND PAYMENT REMINDER SENT*\n` +
            `Agent: ${pending.agentName} (${phone})\n` +
            `Voucher: ${pending.voucherNo}\n` +
            `Amount: Rs.${secondAmt.toLocaleString()} (35%)`
          );

          // Update payment step
          pendingPayments[phone].paymentStep = 2;
          delete pendingPayments[phone].secondPaymentReminderDate;
          console.log(`✓ 2nd payment reminder sent to ${phone} for voucher ${pending.voucherNo}`);
        } catch(e) {
          console.error(`✗ 2nd payment reminder error for ${phone}:`, e.message);
        }
      }
    }
  } catch(e) {
    console.error("Daily payment cron error:", e.message);
  }
}, { timezone: "Asia/Kolkata" });

console.log("⏰ Daily payment reminder cron scheduled at 9 AM IST");

// ── DAILY BLAST BATCH — runs every hour 9AM to 5PM IST ───────────────────
// Spreads 50 messages through the day naturally (not all at once)
cron.schedule("0 9,10,11,12,13,14,15,16 * * *", async () => {
  try {
    const { blastQueue, runBlastBatch } = require("./handler");
    if (!blastQueue || !blastQueue.message) return;
    console.log(`⏰ Blast cron: running batch. Pending: ${blastQueue.pending.length}`);
    const ADMIN_PHONE = process.env.ADMIN_PHONE || "919816003322";
    await runBlastBatch(ADMIN_PHONE);
  } catch (err) {
    console.error("Blast cron error:", err.message);
  }
}, { timezone: "Asia/Kolkata" });

console.log("⏰ Blast cron scheduled hourly 9AM-5PM IST (50/day max)");

// ── AC STATUS REMINDER — every 2 hours ────────────────────────
const AC_REMINDER_PHONE = "918627038322";
const AC_TEMPLATE_NAME = "ac_status_reminder";

async function sendACReminder() {
  try {
    const { sendTemplate } = require("./whatsapp");
    const result = await sendTemplate(AC_REMINDER_PHONE, AC_TEMPLATE_NAME);
    console.log(`✓ AC reminder (template) sent to ${AC_REMINDER_PHONE}:`, result?.messages?.[0]?.id);
  } catch (err) {
    console.error("✗ AC reminder error:", err.response?.data || err.message);
  }
}

// Send every 2 hours (7200000 ms)
setInterval(sendACReminder, 2 * 60 * 60 * 1000);

// Also send once on server start (after 10 seconds)
setTimeout(sendACReminder, 10000);

console.log("⏰ AC status reminder scheduled every 2 hours to " + AC_REMINDER_PHONE);
