const sessions = {};

const {
  sendMessage, sendReminder, sendEnquiryAck,
  sendRoomAvailable, sendNotAvailable, sendConfirmed, sendAskPlan,
} = require("./whatsapp");
const { parseEnquiry } = require("./parser");
const { checkAvailability } = require("./stayezee");
const { isAgent, getAgent, addAgent, removeAgent, listAgents } = require("./agents");
const { getRate, getSeason } = require("./rates");

const ADMIN_PHONE = process.env.ADMIN_PHONE || "919816003322";
const MAX_ROOMS = 5;
const FY_START = new Date("2026-04-01");
const FY_END   = new Date("2027-03-31");

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  try { return new Date(dateStr).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return dateStr; }
}

function isWithinFY(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d >= FY_START && d <= FY_END;
}

async function handleIncoming({ from, text, msgId }) {
  const t = text.trim().toUpperCase();
  console.log(`📨 From ${from}: ${text}`);

  // ── ADMIN COMMANDS ─────────────────────────────────────────────────────
  if (from === ADMIN_PHONE) {
    // ADD AGENT 91XXXXXXXXXX Name A
    const addMatch = text.match(/^ADD\s+AGENT\s+(\d+)\s+(.+?)\s+([ABC])$/i);
    const addMatch2 = text.match(/^ADD\s+AGENT\s+(\d+)\s+(.+)/i);
    if (addMatch) {
      const result = await addAgent(addMatch[1].trim(), addMatch[2].trim(), addMatch[3].trim());
      await sendMessage(from, result.message);
      return;
    }
    if (addMatch2) {
      const result = await addAgent(addMatch2[1].trim(), addMatch2[2].trim(), "C");
      await sendMessage(from, result.message + "\n\n_No category specified — added as Category C_");
      return;
    }
    const removeMatch = text.match(/^REMOVE\s+AGENT\s+(\d+)/i);
    if (removeMatch) {
      const result = await removeAgent(removeMatch[1].trim());
      await sendMessage(from, result.message);
      return;
    }
    if (t === "LIST AGENTS" || t === "LIST") {
      const list = await listAgents();
      await sendMessage(from, list);
      return;
    }
    const availMatch = text.match(/^AVAIL\s+(\d+)(?:\s+(\d+))?/i);
    const notAvailMatch = text.match(/^NOTAVAIL\s+(\d+)/i);
    if (availMatch) {
      await handleAdminReply({ command: "AVAIL", agentPhone: availMatch[1], rate: availMatch[2] || null });
      return;
    }
    if (notAvailMatch) {
      await handleAdminReply({ command: "NOTAVAIL", agentPhone: notAvailMatch[1] });
      return;
    }
    if (t === "HELP" || t === "COMMANDS") {
      await sendMessage(from,
        `🤖 *Admin Commands:*\n\n` +
        `*ADD AGENT 91XXXXXXXXXX Name A* — Add Category A agent\n` +
        `*ADD AGENT 91XXXXXXXXXX Name B* — Add Category B agent\n` +
        `*ADD AGENT 91XXXXXXXXXX Name C* — Add Category C agent\n` +
        `*REMOVE AGENT 91XXXXXXXXXX* — Remove agent\n` +
        `*LIST AGENTS* — See all agents with categories\n` +
        `*AVAIL 91XXXXXXXXXX 3500* — Manual available\n` +
        `*NOTAVAIL 91XXXXXXXXXX* — Manual not available\n` +
        `*HELP* — Show commands\n\n` +
        `*Categories:*\n` +
        `A = Best agents (${process.env.DISCOUNT_A || 10}% discount)\n` +
        `B = Standard agents (${process.env.DISCOUNT_B || 5}% discount)\n` +
        `C = Regular agents (no discount)`
      );
      return;
    }
  }

  // ── CHECK IF ALLOWED AGENT ─────────────────────────────────────────────
  const agent = await getAgent(from);
  if (!agent) {
    console.log(`⛔ Blocked — ${from} is not a registered agent`);
    await sendMessage(from,
      `Sorry, this service is for registered travel agents only. 🙏\n\nPlease contact us:\n📞 +91 88948 88885`
    );
    return;
  }

  // ── AGENT FLOW ─────────────────────────────────────────────────────────
  if (!sessions[from]) sessions[from] = { step: "idle" };
  const session = sessions[from];
  session.agentName = agent.name;
  session.agentCategory = agent.category;

  // Awaiting room type
  if (session.step === "awaiting_room_type") {
    const lower = text.toLowerCase();
    if (lower.includes("honey")) { session.roomType = "honeymoon"; }
    else if (lower.includes("super")) { session.roomType = "superdeluxe"; }
    else if (lower.includes("deluxe") || text === "1") { session.roomType = "deluxe"; }
    else if (text === "2") { session.roomType = "superdeluxe"; }
    else if (text === "3") { session.roomType = "honeymoon"; }
    else {
      await sendMessage(from, `Please reply:\n*1* — Deluxe\n*2* — Super Deluxe\n*3* — Honeymoon`);
      return;
    }
    session.step = "idle";
    if (!session.plan) {
      session.step = "awaiting_plan";
      await sendAskPlan(from, session);
    } else {
      await processEnquiry(from, session);
    }
    return;
  }

  // Awaiting plan
  if (session.step === "awaiting_plan") {
    if (["CP", "MAP", "EP"].includes(t)) {
      session.plan = t;
      await processEnquiry(from, session);
      return;
    }
  }

  // Awaiting YES/NO
  if (session.step === "awaiting_confirm") {
    if (["YES", "Y", "CONFIRM", "OK", "HAAN", "HA"].includes(t)) {
      session.step = "idle";
      await sendConfirmed(from, session);
      return;
    }
    if (["NO", "N", "CANCEL", "NAHI", "NOPE"].includes(t)) {
      session.step = "idle";
      await sendMessage(from, `Dear *${agent.name}*,\n\nUnderstood! The hold has been released. Feel free to enquire again anytime. 🙏`);
      return;
    }
  }

  // ── Parse new enquiry ──────────────────────────────────────────────────
  const enquiry = parseEnquiry(text);
  if (!enquiry) {
    if (session.step === "idle") await sendMessage(from, helpMessage(agent.name));
    return;
  }

  Object.assign(session, enquiry, { agentPhone: from });

  // ── Validation ─────────────────────────────────────────────────────────
  if (enquiry.rooms > MAX_ROOMS) {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nSorry, online booking is limited to *${MAX_ROOMS} rooms maximum*. 🙏\n\n` +
      `For group bookings contact us:\n📞 *+91 88948 88885*`
    );
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);
  const ciDate = new Date(enquiry.ciDate);
  const coDate = enquiry.coDate ? new Date(enquiry.coDate) : null;

  if (ciDate < today) {
    await sendMessage(from, `Dear *${agent.name}*,\n\nSorry, check-in date *${fmtDate(enquiry.ciDate)}* is in the past. 📅\n\nPlease send a future date.`);
    return;
  }

  if (!isWithinFY(enquiry.ciDate)) {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nSorry, bookings are only accepted for:\n📅 *1 April 2026 — 31 March 2027*\n\nYour check-in *${fmtDate(enquiry.ciDate)}* is outside this range.`
    );
    return;
  }

  if (coDate && !isWithinFY(enquiry.coDate)) {
    await sendMessage(from, `Dear *${agent.name}*,\n\nCheck-out date *${fmtDate(enquiry.coDate)}* is beyond 31 March 2027. 📅`);
    return;
  }

  if (coDate && ciDate >= coDate) {
    await sendMessage(from, `Dear *${agent.name}*,\n\nCheck-out must be after check-in date. 📅`);
    return;
  }

  // ── Ask room type if missing ───────────────────────────────────────────
  if (!enquiry.roomType) {
    session.step = "awaiting_room_type";
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nPlease select room type:\n\n*1* — Deluxe Room\n*2* — Super Deluxe Room\n*3* — Honeymoon Room`
    );
    return;
  }

  // ── Ask plan if missing ────────────────────────────────────────────────
  if (!enquiry.plan) {
    session.step = "awaiting_plan";
    await sendAskPlan(from, session);
    return;
  }

  await processEnquiry(from, session);
}

// ── Auto check availability + get rate ────────────────────────────────────
async function processEnquiry(from, session) {
  session.step = "pending_check";

  // Get rate based on room type, plan, season, and category
  const rateInfo = getRate(session.roomType, session.plan, session.ciDate, session.agentCategory);
  if (rateInfo) {
    session.rate = rateInfo.rate;
    session.season = rateInfo.season;
    session.roomTypeName = rateInfo.roomType;
    console.log(`💰 Rate for ${session.agentName} (Cat ${session.agentCategory}): ₹${rateInfo.rate} (${rateInfo.season} season, ${rateInfo.discount}% discount)`);
  }

  await sendEnquiryAck(from, session);
  console.log(`🔍 Checking Stayezee for ${from}...`);

  const result = await checkAvailability({
    ciDate: session.ciDate,
    coDate: session.coDate,
    rooms: session.rooms,
  });

  if (result.available === null) {
    session.step = "pending_check";
    await sendReminder(ADMIN_PHONE,
      `🔔 *Auto-check failed*\n\nAgent: ${session.agentName} (${from}) [Cat ${session.agentCategory}]\n` +
      `📅 ${session.ciDate} → ${session.coDate}\n🛏 ${session.rooms} ${session.roomTypeName || ""} rooms | ${session.plan}\n` +
      `💰 Rate: ₹${session.rate || "TBD"}\n\nReply:\n✅ AVAIL ${from} ${session.rate || "<rate>"}\n❌ NOTAVAIL ${from}`
    );
    return;
  }

  if (result.available) {
    session.step = "awaiting_confirm";
    await sendRoomAvailable(from, session);
    await sendReminder(ADMIN_PHONE,
      `✅ *Available*\nAgent: ${session.agentName} (${from}) [Cat ${session.agentCategory}]\n` +
      `📅 ${session.ciDate} → ${session.coDate}\n🛏 ${session.rooms} ${session.roomTypeName || ""} | ${session.plan}\n` +
      `💰 Rate: ₹${session.rate} (${session.season} season)\nWaiting for confirmation.`
    );
  } else {
    session.step = "idle";
    await sendNotAvailable(from, session);
    await sendReminder(ADMIN_PHONE,
      `❌ *Not Available*\nAgent: ${session.agentName} (${from})\n📅 ${session.ciDate} → ${session.coDate}`
    );
  }
}

async function handleAdminReply({ command, agentPhone, rate }) {
  const session = sessions[agentPhone];
  if (!session) {
    await sendMessage(ADMIN_PHONE, `⚠ No active session for ${agentPhone}`);
    return;
  }
  if (command === "AVAIL") {
    session.rate = rate;
    session.step = "awaiting_confirm";
    await sendRoomAvailable(agentPhone, session);
  } else if (command === "NOTAVAIL") {
    session.step = "idle";
    await sendNotAvailable(agentPhone, session);
  }
}

function helpMessage(name) {
  return (
    `👋 Dear *${name}*,\n\n` +
    `Send your enquiry like:\n` +
    `_"Need 2 Deluxe rooms, check-in 15 May, check-out 17 May, CP plan"_\n\n` +
    `Include:\n• Room type: Deluxe / Super Deluxe / Honeymoon\n• Check-in & check-out dates\n• Number of rooms (max 5)\n• Plan: CP / MAP\n\n` +
    `📅 Bookings: 1 Apr 2026 — 31 Mar 2027\n\nWe'll reply shortly! 🙏`
  );
}

module.exports = { handleIncoming, handleAdminReply };
