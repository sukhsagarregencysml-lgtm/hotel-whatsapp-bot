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
    if (msg.type !== "text") return;
    const from = msg.from;
    const text = msg.text?.body || "";
    console.log(`📨 From ${from}: ${text}`);
    await handleIncoming({ from, text, msgId: msg.id });
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

    // Store pending opt-in
    pendingOptIns[phone] = {
      guestName, hotelName, reservationId,
      room: room || "Your room",
      checkout: checkout || "As per booking",
      plan: plan || "EP",
      wifi: wifi || "Ask reception",
      timestamp: Date.now()
    };

    // Send opt-in request to guest
    const msg = 
      `Dear ${guestName},\n\n` +
      `Your booking at ${hotelName} is confirmed!\n\n` +
      `Reply *YES* to receive your check-in details and updates on WhatsApp.\n\n` +
      `Team ${hotelName}`;

    await sendMessage(phone, msg);
    console.log(`Opt-in request sent to ${phone} for booking ${reservationId}`);
    res.json({ success: true, message: "Opt-in request sent to " + phone });
  } catch (err) {
    console.error("Opt-in error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- POST /send-checkin -- called by PMS on check-in ---------------
app.post("/send-checkin", async (req, res) => {
  try {
    const { phone, guestName, hotelName, room, checkout, plan, wifi } = req.body;
    const { sendMessage } = require("./whatsapp");

    const msg =
      `Welcome to ${hotelName}! 🏨\n\n` +
      `Dear ${guestName},\n\n` +
      `You are now checked in. Here are your details:\n\n` +
      `Room: ${room}\n` +
      `Check-out: ${checkout}\n` +
      `Plan: ${plan}\n` +
      `WiFi: ${wifi}\n\n` +
      `For assistance please call reception.\n\n` +
      `We wish you a wonderful stay!\n` +
      `Team ${hotelName}`;

    await sendMessage(phone, msg);
    res.json({ success: true, message: "Check-in message sent to " + phone });
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

// -- POST /test-stayezee -- test saveReservation directly ------
app.post("/test-stayezee", async (req, res) => {
  try {
    const { saveReservation } = require("./stayezee");
    const result = await saveReservation({
      guestName: req.body.guestName || "Test Guest",
      guestMobile: req.body.guestMobile || "919816003322",
      male: 1, female: 0, kids: 0,
      plan: req.body.plan || "CP",
      tariff: req.body.tariff || 4100,
      rooms: req.body.rooms || 1,
      checkinDate: req.body.checkinDate || "10-05-2026",
      checkoutDate: req.body.checkoutDate || "12-05-2026",
      roomType: req.body.roomType || "Deluxe"
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
