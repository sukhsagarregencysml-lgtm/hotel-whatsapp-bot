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

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
