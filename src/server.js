require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const { handleIncoming } = require("./handler");
const { registerGuestForServices, sendServiceMenu, startFeedback } = require("./guest-services");
const { registerGuestForServices, sendServiceMenu, startFeedback } = require("./guest-services");

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
    await handleIncoming({ from, text, msgId: msg.id, msgType, mediaId, contextMsgId, buttonId });
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
  // Optional API key auth — set STAYEZEE_API_KEY in .env to enable
  const apiKey = process.env.STAYEZEE_API_KEY;
  if (apiKey && req.headers["x-api-key"] !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { phone, guestName, hotelName, room, checkout, plan, wifi } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName are required" });
    const { sendMessage } = require("./whatsapp");

    const msg =
      `🏨 *Welcome to ${hotelName}!*\n\n` +
      `Dear *${guestName}*,\n\n` +
      `You are now successfully checked in. Here are your stay details:\n\n` +
      `🛏 *Room:* ${room}\n` +
      `📅 *Check-out:* ${checkout}\n` +
      `🍽 *Meal Plan:* ${plan}\n` +
      `📶 *WiFi Password:* ${wifi}\n\n` +
      `📞 For any assistance, please call reception or reply to this message.\n\n` +
      `We wish you a wonderful and comfortable stay! 🙏\n` +
      `*Team ${hotelName}*`;

    await sendMessage(phone, msg);

    // Register guest for WhatsApp service requests
    registerGuestForServices(phone, guestName, hotelName, room, checkout);

    // Send service menu 30 seconds after check-in message
    setTimeout(async () => {
      try {
        const wa = require("./whatsapp");
        await sendServiceMenu(phone, wa);
      } catch(e) { console.log("Service menu error:", e.message); }
    }, 30000);

    res.json({ success: true, message: "Check-in message sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const { phone, guestName, hotelName, roomCharges, gst, total, reviewLink } = req.body;
    if (!phone || !guestName) return res.status(400).json({ error: "phone and guestName are required" });
    const { sendMessage } = require("./whatsapp");

    const msg =
      `🙏 *Thank You for Staying with Us!*\n\n` +
      `Dear *${guestName}*,\n\n` +
      `It was a pleasure having you at *${hotelName}*. We hope you had a wonderful stay!\n\n` +
      `📋 *Final Bill Summary*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏷 Room Charges: Rs.${Number(roomCharges).toLocaleString('en-IN')}\n` +
      `📊 GST: Rs.${Number(gst).toLocaleString('en-IN')}\n` +
      `💰 *Total Paid: Rs.${Number(total).toLocaleString('en-IN')}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `We look forward to welcoming you again! 😊\n\n` +
      (reviewLink ? `⭐ Loved your stay? Please share your experience:\n${reviewLink}\n\n` : "") +
      `*Team ${hotelName}*`;

    await sendMessage(phone, msg);

    // Send feedback/rating request 2 minutes after checkout message
    setTimeout(async () => {
      try {
        const wa = require("./whatsapp");
        await startFeedback(phone, guestName, wa);
      } catch(e) { console.log("Feedback error:", e.message); }
    }, 2 * 60 * 1000);

    res.json({ success: true, message: "Checkout message sent to " + phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
const axios = require("axios");

const AC_REMINDER_PHONE = "918627038322";
const AC_TEMPLATE_NAME = "ac_status_reminder";

async function sendACReminder() {
  try {
    const phoneId = process.env.WA_PHONE_NUMBER_ID;
    const token = process.env.WA_ACCESS_TOKEN;
    if (!phoneId || !token) {
      console.log("AC reminder: WA credentials not set");
      return;
    }

    // Try plain text first (works if they messaged within 24hrs)
    // Fallback to template if plain text fails
    let sent = false;

    try {
      const res = await axios.post(
        `https://graph.facebook.com/v25.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: AC_REMINDER_PHONE,
          type: "text",
          text: { body: "Kindly update AC status on group 🙏" }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );
      console.log(`✓ AC reminder (text) sent to ${AC_REMINDER_PHONE}:`, res.data?.messages?.[0]?.id);
      sent = true;
    } catch(textErr) {
      console.log("Plain text failed, trying template...", textErr.response?.data?.error?.message);
    }

    // Fallback to template if plain text failed
    if (!sent) {
      const res = await axios.post(
        `https://graph.facebook.com/v25.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: AC_REMINDER_PHONE,
          type: "template",
          template: {
            name: AC_TEMPLATE_NAME,
            language: { code: "en" }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );
      console.log(`✓ AC reminder (template) sent to ${AC_REMINDER_PHONE}:`, res.data?.messages?.[0]?.id);
    }
  } catch (err) {
    console.error("✗ AC reminder error:", err.response?.data || err.message);
  }
}

// Send every 2 hours (7200000 ms)
setInterval(sendACReminder, 2 * 60 * 60 * 1000);

// Also send once on server start (after 10 seconds)
setTimeout(sendACReminder, 10000);

console.log("⏰ AC status reminder scheduled every 2 hours to " + AC_REMINDER_PHONE);
