"use strict";
const { parseEnquiry } = require("./parser");
const { getTally, updateTally, useFreeRooms, getAllAgents } = require("./agents");
const { checkAvailability, saveReservation, cancelReservation } = require("./stayezee");
const { getRate, getCustomerRate, CUSTOMER_EXTRAS } = require("./rates");
const {
  sendMessage, sendTemplate, sendReminder, sendEnquiryAck,
  sendRoomAvailable, sendNotAvailable, sendConfirmed, sendAskPlan,
} = require("./whatsapp");

const ADMIN_PHONE = process.env.ADMIN_PHONE || "919816003322";

// Session store
const sessions = {};
const pendingOptIns = {};
const optedInGuests = {};
const guestSessions = {};
const pendingPayments = {}; // phone -> { agentName, amount, total, remaining, voucherNo, ciDate, coDate }
const pendingCancellations = {}; // voucherNo -> { agentPhone, agentName, guestName, ciDate, coDate, voucherNo, advancePaid }
const adminNotifMsgMap = {}; // msgId of admin notification -> agentPhone (for reply-to detection)
let lastPendingPaymentPhone = null; // phone of last agent who sent payment screenshot

// ── BLAST QUEUE — persists in memory, 50/day with retry ──────────────────
const blastQueue = {
  message: null,        // current blast message
  pending: [],          // phones yet to be sent
  failed: [],           // phones that failed — retry next day
  sentCount: 0,         // total sent so far
  todaySent: 0,         // sent today (resets at midnight)
  lastResetDate: null,  // date of last daily reset
};

// Hotel info - customize per hotel
const HOTEL_INFO = {
  name: process.env.HOTEL_NAME || "Hotel Sukhsagar Regency",
  location: process.env.HOTEL_LOCATION || "Shimla, Himachal Pradesh",
  googleMaps: process.env.HOTEL_MAPS_URL || "https://maps.google.com/?q=31.078199,77.140404",
  phone: process.env.HOTEL_PHONE || "+91 98160 03322",
  photos: process.env.HOTEL_PHOTOS_URL || "https://www.sukhsagarregency.com",
  checkIn: process.env.HOTEL_CHECKIN_TIME || "12:00 PM",
  checkOut: process.env.HOTEL_CHECKOUT_TIME || "11:00 AM",
};

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function getExtraPersonCharge(plan) {
  return plan === "MAP" || plan === "MAPAI" ? 1300 : 800;
}

function getChildNoBedCharge(plan) {
  return plan === "MAP" || plan === "MAPAI" ? 800 : 400;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

async function getAgent(phone) {
  const db = require("./agents");
  return db.getAgent(phone);
}

async function handleIncoming({ from, text, msgId, msgType, mediaId, contextMsgId }) {
  const t = (text || "").trim().toUpperCase();
  console.log(`MSG From ${from}: ${text || "[media]"}`);

  // -- PAYMENT SCREENSHOT HANDLER -----------------------------------------
  if (msgType === "image" && from !== ADMIN_PHONE) {
    const pending = pendingPayments[from];
    if (pending) {
      // Notify agent
      await sendMessage(from,
        `✅ *Screenshot received!*\n\n` +
        `Voucher: *${pending.voucherNo}*\n` +
        `Amount: Rs.${pending.amount.toLocaleString()}\n\n` +
        `Pending admin approval. You will be notified once confirmed. 🙏`
      );
      // Notify admin with approve/reject commands
      const notifResult = await sendReminder(ADMIN_PHONE,
        `📸 *PAYMENT SCREENSHOT RECEIVED*\n\n` +
        `Agent: ${pending.agentName} (${from})\n` +
        `Voucher: ${pending.voucherNo}\n` +
        `Amount: Rs.${pending.amount.toLocaleString()}\n` +
        `Guest: ${pending.guestName}\n` +
        `Check-in: ${fmtDate(pending.ciDate)}\n\n` +
        `Reply *YES* to approve or *NO* to reject\n` +
        `Or: *APPROVE PAY ${from} ${pending.amount}*`
      );
      // Store msgId so admin can reply to this specific message
      if (notifResult?.messages?.[0]?.id) {
        adminNotifMsgMap[notifResult.messages[0].id] = { agentPhone: from, amount: pending.amount };
      }
      lastPendingPaymentPhone = from;
      return;
    }
  }

  // -- GUEST OPT-IN HANDLER -----------------------------------------------
  if (t === "YES" || t === "HI" || t === "HELLO" || t === "Y") {
    const pending = pendingOptIns[from];
    if (pending) {
      optedInGuests[from] = true;
      delete pendingOptIns[from];
      const msg =
        `Welcome to ${pending.hotelName}! 🏨\n\n` +
        `Dear ${pending.guestName},\n\n` +
        `You are now checked in. Here are your details:\n\n` +
        `Room: ${pending.room}\n` +
        `Check-out: ${pending.checkout}\n` +
        `Plan: ${pending.plan}\n` +
        `WiFi: ${pending.wifi}\n\n` +
        `For assistance please call reception.\n\n` +
        `We wish you a wonderful stay!\n` +
        `Team ${pending.hotelName}`;
      await sendMessage(from, msg);
      return;
    }
  }

  // -- ADMIN COMMANDS -----------------------------------------------------
  if (from === ADMIN_PHONE) {
    await handleAdminReply(from, text, t, contextMsgId);
    return;
  }

  // -- CHECK IF REGISTERED AGENT ------------------------------------------
  const agent = await getAgent(from);
  if (!agent || agent.category === "Guest") {
    // For guests — check payment screenshot BEFORE routing to guest flow
    if (msgType === "image" && agent && agent.category === "Guest") {
      const pending = pendingPayments[from];
      if (pending) {
        await sendMessage(from,
          `✅ *Screenshot received!*\n\n` +
          `Voucher: *${pending.voucherNo}*\n` +
          `Amount: Rs.${pending.amount.toLocaleString()}\n\n` +
          `Pending admin approval. You will be notified once confirmed. 🙏`
        );
        await sendReminder(ADMIN_PHONE,
          `📸 *PAYMENT SCREENSHOT RECEIVED*\n\n` +
          `Guest: ${pending.agentName} (${from})\n` +
          `Voucher: ${pending.voucherNo}\n` +
          `Amount: Rs.${pending.amount.toLocaleString()}\n` +
          `Guest Name: ${pending.guestName}\n` +
          `Check-in: ${fmtDate(pending.ciDate)}\n\n` +
          `To approve: *APPROVE PAY ${from} ${pending.amount}*\n` +
          `To reject: *REJECT PAY ${from}*`
        );
        return;
      }
    }
    // Clear any accidental agent session for guests
    if (agent && agent.category === "Guest" && sessions[from]?.step && sessions[from].step !== "idle") {
      sessions[from] = { step: "idle" };
    }
    await handleGuest(from, text, t);
    return;
  }

  // Clear any guest session if this person is actually an agent
  if (guestSessions[from]) {
    delete guestSessions[from];
  }

  // -- MULTI-STEP AGENT SESSION HANDLERS ----------------------------------
  const session = sessions[from] || { step: "idle" };
  sessions[from] = session;
  session.agentName = agent.name;
  session.agentCategory = agent.category;

  // ── CANCEL BOOKING COMMAND ────────────────────────────────────
  if (t === "CANCEL" || t === "CANCEL BOOKING" || t === "CANCELLATION") {
    // Find all active bookings for this agent from pendingPayments
    const agentBookings = Object.entries(pendingPayments)
      .filter(([phone, p]) => phone === from || p.agentPhone === from)
      .map(([phone, p]) => p);

    if (agentBookings.length === 0) {
      await sendMessage(from,
        `❌ No active bookings found to cancel.\n\n` +
        `If your booking is confirmed and payment was completed, please contact hotel directly:\n📞 +91 98160 03322`
      );
      return;
    }

    if (agentBookings.length === 1) {
      // Only one booking — show it directly
      const b = agentBookings[0];
      session.step = "awaiting_cancel_confirm";
      session.cancelVoucherNo = b.voucherNo;
      const daysLeft = Math.round((new Date(b.ciDate) - new Date()) / 86400000);
      const refund = daysLeft > 15 ? "Full refund" : "No refund (within 15 days)";
      await sendMessage(from,
        `❌ *CANCEL BOOKING REQUEST*\n\n` +
        `Voucher: *${b.voucherNo}*\n` +
        `Guest: ${b.guestName}\n` +
        `Check-in: ${fmtDate(b.ciDate)}\n` +
        `Check-out: ${fmtDate(b.coDate)}\n` +
        `Advance Paid: Rs.${(b.paidSoFar || b.amount || 0).toLocaleString()}\n\n` +
        `⚠️ *Cancellation Policy:*\n` +
        `${daysLeft > 15 ? "✅" : "❌"} ${refund}\n\n` +
        `Reply *YES* to request cancellation\n` +
        `Reply *NO* to keep booking`
      );
    } else {
      // Multiple bookings — show list
      session.step = "awaiting_cancel_select";
      session.cancelOptions = agentBookings;
      const lines = agentBookings.map((b, i) =>
        `*${i+1}.* ${b.voucherNo} — ${b.guestName} — ${fmtDate(b.ciDate)}`
      );
      await sendMessage(from,
        `❌ *Which booking to cancel?*\n\n` +
        lines.join("\n") + `\n\n` +
        `Reply with number (1, 2, 3...)`
      );
    }
    return;
  }

  // Step: awaiting cancel selection (multiple bookings)
  if (session.step === "awaiting_cancel_select") {
    const idx = parseInt(t) - 1;
    if (isNaN(idx) || idx < 0 || idx >= (session.cancelOptions || []).length) {
      await sendMessage(from, `Please reply with a number between 1 and ${(session.cancelOptions||[]).length}`);
      return;
    }
    const b = session.cancelOptions[idx];
    session.step = "awaiting_cancel_confirm";
    session.cancelVoucherNo = b.voucherNo;
    const daysLeft = Math.round((new Date(b.ciDate) - new Date()) / 86400000);
    const refund = daysLeft > 15 ? "Full refund" : "No refund (within 15 days)";
    await sendMessage(from,
      `❌ *CANCEL BOOKING REQUEST*\n\n` +
      `Voucher: *${b.voucherNo}*\n` +
      `Guest: ${b.guestName}\n` +
      `Check-in: ${fmtDate(b.ciDate)}\n` +
      `Check-out: ${fmtDate(b.coDate)}\n` +
      `Advance Paid: Rs.${(b.paidSoFar || b.amount || 0).toLocaleString()}\n\n` +
      `⚠️ *Cancellation Policy:*\n` +
      `${daysLeft > 15 ? "✅" : "❌"} ${refund}\n\n` +
      `Reply *YES* to request cancellation\n` +
      `Reply *NO* to keep booking`
    );
    return;
  }

  // Step: awaiting cancel confirmation
  if (session.step === "awaiting_cancel_confirm") {
    if (["YES","Y","HAAN","HA"].includes(t)) {
      const voucherNo = session.cancelVoucherNo;
      // Find booking in pendingPayments
      const bookingEntry = Object.entries(pendingPayments).find(([p, b]) => b.voucherNo === voucherNo);
      const booking = bookingEntry ? bookingEntry[1] : null;

      if (!booking) {
        await sendMessage(from, `Could not find booking ${voucherNo}. Please contact hotel: 📞 +91 98160 03322`);
        session.step = "idle";
        return;
      }

      const daysLeft = Math.round((new Date(booking.ciDate) - new Date()) / 86400000);
      const refund = daysLeft > 15 ? booking.paidSoFar || booking.amount || 0 : 0;

      // Store in pendingCancellations for admin approval
      pendingCancellations[voucherNo] = {
        agentPhone: from,
        agentName: agent.name,
        guestName: booking.guestName,
        ciDate: booking.ciDate,
        coDate: booking.coDate,
        voucherNo,
        advancePaid: booking.paidSoFar || booking.amount || 0,
        refundAmount: refund,
        daysLeft,
        stayezeeId: booking.stayezeeId,
        requestedAt: new Date().toISOString()
      };

      // Notify agent
      await sendMessage(from,
        `✅ *Cancellation request submitted!*\n\n` +
        `Voucher: *${voucherNo}*\n` +
        `Guest: ${booking.guestName}\n\n` +
        `Your request is pending admin approval.\n` +
        `You will be notified once processed. 🙏`
      );

      // Notify admin
      await sendReminder(ADMIN_PHONE,
        `❌ *CANCELLATION REQUEST*\n\n` +
        `Agent: ${agent.name} (${from})\n` +
        `Voucher: *${voucherNo}*\n` +
        `Guest: ${booking.guestName}\n` +
        `Check-in: ${fmtDate(booking.ciDate)}\n` +
        `Advance Paid: Rs.${(booking.paidSoFar || booking.amount || 0).toLocaleString()}\n` +
        `Days to Check-in: ${daysLeft}\n` +
        `Refund: ${daysLeft > 15 ? `Rs.${refund.toLocaleString()} (Full)` : "No refund"}\n\n` +
        `To approve: *APPROVE CANCEL ${voucherNo}*\n` +
        `To reject: *REJECT CANCEL ${voucherNo}*`
      );

      session.step = "idle";
      delete session.cancelVoucherNo;
      delete session.cancelOptions;
    } else if (["NO","N","NAHI"].includes(t)) {
      await sendMessage(from, `Cancellation cancelled. Your booking is still active. 🙏`);
      session.step = "idle";
      delete session.cancelVoucherNo;
      delete session.cancelOptions;
    }
    return;
  }

  // Step: awaiting guest name
  if (session.step === "awaiting_guest_name") {
    session.guestName = text.trim();
    session.step = "awaiting_guest_mobile";
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nThank you! Now please share the *guest mobile number*:\n\nExample: *919876543210*`
    );
    return;
  }

  // Step: awaiting guest mobile
  if (session.step === "awaiting_guest_mobile") {
    const mobile = text.replace(/\D/g, "");
    session.guestMobile = mobile.startsWith("91") ? mobile : "91" + mobile;
    session.step = "awaiting_extra_bed";
    const extraPersonCharge = getExtraPersonCharge(session.plan);
    const childNoBedCharge = getChildNoBedCharge(session.plan);
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nDo you need an *extra bed*?\n\n` +
      `*1* - Extra person (above 10 yrs) with mattress - Rs.${extraPersonCharge}/night\n` +
      `*2* - Child no bed (6 to 10 yrs) - Rs.${childNoBedCharge}/night\n` +
      `*3* - Child (under 5 yrs) - FREE\n` +
      `*NO* - No extra bed needed`
    );
    return;
  }

  // Step: awaiting extra bed
  // Accepts: 1/CWB/EXTRA PERSON, 2/CNB/CHILD NO BED, 3/FREE/CHILD UNDER 5, NO/4
  if (session.step === "awaiting_extra_bed") {
    const isCWB = ["1","CWB","EXTRA","EXTRA PERSON","EXTRA BED","MATTRESS","EB"].includes(t);
    const isCNB = ["2","CNB","CHILD NO BED","CNB ABOVE","CHILD","NO BED"].includes(t) || t.startsWith("CNB");
    const isFree = ["3","FREE","CHILD FREE","CHILD UNDER 5","UNDER 5","BABY","0"].includes(t);
    const isNo = ["4","NO","NONE","N","NO EXTRA","NOT NEEDED"].includes(t);

    if (isCWB) {
      session.extraBed = 1; session.extraBedCharge = getExtraPersonCharge(session.plan); session.extraBedType = "Extra person (above 10 yrs) with mattress";
    } else if (isCNB) {
      session.extraBed = 1; session.extraBedCharge = getChildNoBedCharge(session.plan); session.extraBedType = "Child no bed (6 to 10 yrs)";
    } else if (isFree) {
      session.extraBed = 1; session.extraBedCharge = 0; session.extraBedType = "Child (under 5 yrs)";
    } else if (isNo) {
      session.extraBed = 0; session.extraBedCharge = 0; session.extraBedType = null;
    } else {
      // Not recognized — ask again
      await sendMessage(from,
        `Please reply with:\n\n` +
        `*1* or *CWB* - Extra person with mattress\n` +
        `*2* or *CNB* - Child no bed (6-10 yrs)\n` +
        `*3* or *FREE* - Child under 5 yrs (free)\n` +
        `*4* or *NO* - No extra bed`
      );
      return;
    }
    session.step = "idle";
    await confirmAndSave(from, agent, session);
    return;
  }

  // Step: awaiting plan
  if (session.step === "awaiting_plan") {
    const planInput = t.trim();
    if (["CP","MAP","MAPAI","EP"].includes(planInput)) {
      session.plan = planInput;
      session.step = "idle";
      await checkAndRespond(from, agent, session);
    } else {
      await sendMessage(from,
        `Please reply with one of:\n*CP* - Continental Plan (breakfast)\n*MAP* - Modified American Plan (breakfast+dinner)\n*MAPAI* - MAP with GST included\n*EP* - Room only`
      );
    }
    return;
  }

  // Step: awaiting upgrade to super deluxe
  if (session.step === "awaiting_upgrade") {
    if (t === "UPGRADE" || t === "YES" || t === "Y") {
      session.roomType = "superdeluxe";
      session.roomTypes = [{ type: "superdeluxe", count: session.rooms || 1 }];
      session.step = "idle";
      await sendMessage(from, `Dear *${agent.name}*,\n\nChecking Super Deluxe availability...`);
      await checkAndRespond(from, agent, session);
      return;
    } else {
      session.step = "idle";
      await sendMessage(from, `Dear *${agent.name}*,\n\nNo problem! Feel free to send a new enquiry with different dates. 🙏`);
      return;
    }
  }

  // Step: awaiting checkout date
  if (session.step === "awaiting_checkout") {
    const parsed = parseEnquiry("dlx " + text);
    if (parsed?.ciDate) {
      session.coDate = parsed.ciDate;
      session.step = "idle";
      if (!session.plan) {
        session.step = "awaiting_plan";
        await sendAskPlan(from, agent.name, session);
      } else {
        await checkAndRespond(from, agent, session);
      }
    } else {
      await sendMessage(from, `Please share the *check-out date*.\nExample: *12 July*`);
    }
    return;
  }

  // Step: awaiting confirm
  if (session.step === "awaiting_confirm") {
    // Handle room upgrade
    // Super Deluxe upgrade
    const isSuperUpgrade = [
      "SUPER","SUPERDELUXE","SUPER DELUXE","SDL","SDX","SDLX",
      "SUPER DLX","SUPER DEL","S DLX","SD","UPGRADE SUPER",
      "UPGRADE SDL","UPGRADE SUPERDELUXE","UPGRADE SUPER DELUXE"
    ].includes(t);
    if (isSuperUpgrade) {
      session.roomType = "superdeluxe";
      session.roomTypes = [{ type: "superdeluxe", count: session.rooms }];
      await sendMessage(from, `Dear *${agent.name}*, checking Super Deluxe availability...`);
      await checkAndRespond(from, agent, session);
      return;
    }
    // Honeymoon upgrade
    const isHoneyUpgrade = [
      "HONEY","HONEYMOON","HONEY MOON","HM","HMOON",
      "HON","UPGRADE HONEY","UPGRADE HM","UPGRADE HONEYMOON",
      "UPGRADE HONEY MOON","HONEYMOON ROOM"
    ].includes(t);
    if (isHoneyUpgrade) {
      session.roomType = "honeymoon";
      session.roomTypes = [{ type: "honeymoon", count: session.rooms }];
      await sendMessage(from, `Dear *${agent.name}*, checking Honeymoon availability...`);
      await checkAndRespond(from, agent, session);
      return;
    }
    // Deluxe (downgrade back)
    const isDeluxeDowngrade = [
      "DELUXE","DLX","DEL","DELX","UPGRADE DELUXE",
      "DOWNGRADE","NORMAL","STANDARD","BASIC","REGULAR"
    ].includes(t);
    if (isDeluxeDowngrade) {
      session.roomType = "deluxe";
      session.roomTypes = [{ type: "deluxe", count: session.rooms }];
      await sendMessage(from, `Dear *${agent.name}*, checking Deluxe availability...`);
      await checkAndRespond(from, agent, session);
      return;
    }
    if (["YES","Y","CONFIRM","OK","HAAN","HA"].includes(t)) {
      // Clear timeout if exists
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
      }
      // Clear follow-up reminders
      if (session.reminderIds) {
        session.reminderIds.forEach(id => clearTimeout(id));
        session.reminderIds = [];
      }

      // Double check availability before confirming
      await sendMessage(from, `Dear *${agent.name}*,\n\nVerifying room availability...`);

      try {
        const recheck = await checkAvailability({
          ciDate: session.ciDate,
          coDate: session.coDate,
          rooms: session.rooms || 1,
        });

        if (!recheck.available) {
          session.step = "idle";
          await sendMessage(from,
            `Dear *${agent.name}*,\n\nSorry! The rooms were just booked by someone else.\n\n` +
            `Please try different dates or room types. 🙏`
          );
          return;
        }
      } catch(err) {
        console.error("Recheck error:", err.message);
        // Continue if recheck fails
      }

      session.step = "awaiting_guest_name";
      await sendMessage(from,
        `Dear *${agent.name}*,\n\nRooms confirmed! Please share the *guest full name*:`
      );
      return;
    }
    if (["NO","N","CANCEL","NAHI","NAH"].includes(t)) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
      }
      session.step = "idle";
      await sendMessage(from,
        `Dear *${agent.name}*,\n\nUnderstood! The hold has been released. Feel free to enquire again anytime. 🙏`
      );
      return;
    }
    // If agent sends new enquiry while in confirm step - handle it
  }

  // -- PARSE NEW ENQUIRY --------------------------------------------------
  const enquiry = parseEnquiry(text);

  if (enquiry) {
    // Save parsed data to session
    session.ciDate = enquiry.ciDate;
    session.coDate = enquiry.coDate;
    session.rooms = enquiry.rooms || 1;
    session.roomType = enquiry.roomType || "deluxe";
    session.roomTypes = enquiry.roomTypes || null;
    if (enquiry.adults) session.adults = enquiry.adults;
    if (enquiry.kids !== undefined) session.kids = enquiry.kids;
    if (enquiry.kidAges) session.kidAges = enquiry.kidAges;
    if (enquiry.plan) session.plan = enquiry.plan;

    // Validate date
    const today = new Date(); today.setHours(0,0,0,0);
    if (new Date(session.ciDate) < today) {
      await sendMessage(from, `Dear *${agent.name}*,\n\nCheck-in date *${fmtDate(session.ciDate)}* is in the past. Please send a future date.`);
      return;
    }

    // Acknowledge receipt
    const ackMsg =
      `Thanks for your enquiry! 😊\n\n` +
      `Check-in: ${fmtDate(session.ciDate)}\n` +
      `Check-out: ${session.coDate ? fmtDate(session.coDate) : "—"}\n` +
      `Rooms: ${session.rooms}\n` +
      `Adults: ${session.adults || "—"}\n` +
      `Kids: ${session.kids !== undefined ? session.kids : "—"}${session.kidAges ? ` (${session.kidAges.join(", ")} yrs)` : ""}\n` +
      `Plan: ${session.plan || "—"}\n\n` +
      `We are checking availability...`;
    await sendMessage(from, ackMsg);

    // Ask for missing info
    if (!session.coDate) {
      session.step = "awaiting_checkout";
      await sendMessage(from, `Could you please share the *check-out date*?\n\nExample: *12 July*`);
      return;
    }

    if (!session.plan) {
      session.step = "awaiting_plan";
      await sendMessage(from,
        `Could you please share the *meal plan*?\n\nReply with:\n` +
        `*CP* - Continental Plan (with breakfast)\n` +
        `*MAP* - Modified American Plan (breakfast + dinner)\n` +
        `*MAPAI* - MAP with GST included\n` +
        `*EP* - European Plan (room only)`
      );
      return;
    }

    await checkAndRespond(from, agent, session);
    return;
  }

  // -- HANDLE PARTIAL MESSAGES (multi-message support) --------------------
  // If session has some data already, try to fill in missing pieces
  if (session.ciDate && !session.coDate) {
    const parsed = parseEnquiry("dlx " + text);
    if (parsed?.ciDate) {
      session.coDate = parsed.ciDate;
      session.step = "idle";
      if (!session.plan) {
        session.step = "awaiting_plan";
        await sendMessage(from,
          `Got it! Check-out: *${fmtDate(session.coDate)}*\n\nWhat meal plan?\n*CP* / *MAP* / *MAPAI* / *EP*`
        );
      } else {
        await checkAndRespond(from, agent, session);
      }
      return;
    }
  }

  if (session.ciDate && session.coDate && !session.plan) {
    if (["CP","MAP","MAPAI","EP"].includes(t)) {
      session.plan = t;
      await checkAndRespond(from, agent, session);
      return;
    }
  }

  // -- AGENT MENU --------------------------------------------------------
  if (t === "MENU" || t === "0" || t === "HOME") {
    await sendAgentMenu(from, agent.name);
    return;
  }

  if (t === "HELP" || t === "HI" || t === "HELLO" || t === "START") {
    await sendAgentMenu(from, agent.name);
    return;
  }

  // Agent selected menu option
  if ((t === "1" || t === "MENU" || t === "0" || t === "HOME") && session.step !== "awaiting_confirm") {
    await sendAgentMenu(from, agent.name);
    return;
  }

  if (t === "2") {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nView hotel photos:\n\n` +
      `🖼 ${HOTEL_INFO.photos}\n\n` +
      `Reply *0* for main menu.`
    );
    return;
  }

  if (t === "3") {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\n` +
      `*Breakfast Menu*\n` +
      `---------------------------\n` +
      `Butter and jam toast\n` +
      `Cornflakes with milk\n` +
      `Tea and coffee\n` +
      `Upma or poha\n` +
      `Vada sambar or idli sambar\n` +
      `Parantha with curd or poori bhaji\n` +
      `Omelette or egg bhurji\n` +
      `Fresh fruit\n` +
      `Concentrate juice\n` +
      `Pastry muffin\n\n` +
      `*Meal Plans*\n` +
      `---------------------------\n` +
      `*CP* - With Breakfast\n` +
      `*MAP* - Breakfast + Dinner\n` +
      `*MAPAI* - MAP with GST included\n` +
      `*EP* - Room only\n\n` +
      `Reply *0* for main menu.`
    );
    return;
  }

  if (t === "4") {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nHotel location:\n\n` +
      `📍 *${HOTEL_INFO.name}*\n` +
      `${HOTEL_INFO.location}\n\n` +
      `Google Maps: ${HOTEL_INFO.googleMaps}\n\n` +
      `Check-in: ${HOTEL_INFO.checkIn}\n` +
      `Check-out: ${HOTEL_INFO.checkOut}\n\n` +
      `Reply *0* for main menu.`
    );
    return;
  }

  if (t === "5") {
    await sendMessage(from,
      `Dear *${agent.name}*,\n\nContact us:\n\n` +
      `📞 *${HOTEL_INFO.phone}*\n` +
      `📍 ${HOTEL_INFO.location}\n\n` +
      `Reply *0* for main menu.`
    );
    return;
  }

  // Default - show help
  await sendMessage(from,
    `Dear *${agent.name}*,\n\nI didn't understand that. Please send your enquiry like:\n\n` +
    `*2 deluxe CP 10 july 12 july*\n\n` +
    `Reply *HELP* to see all options.`
  );
}

async function checkAndRespond(from, agent, session) {
  try {
    const nights = Math.round((new Date(session.coDate) - new Date(session.ciDate)) / 86400000);
    session.nights = nights;

    // Max 3 nights limit
    if (nights > 3) {
      session.step = "idle";
      await sendMessage(from,
        `Dear *${agent.name}*,\n\n` +
        `Online bookings via WhatsApp are available for *up to 3 nights* only.\n\n` +
        `Your request is for *${nights} nights* (${fmtDate(session.ciDate)} - ${fmtDate(session.coDate)}).\n\n` +
        `For stays longer than 3 nights, please contact our admin:\n\n` +
        `📞 *+91 98160 03322*\n` +
        `📧 info@sukhsagarregency.com\n\n` +
        `Our team will provide special rates for extended stays. 🙏`
      );
      await sendReminder(ADMIN_PHONE,
        `LONG STAY ENQUIRY\nAgent: ${agent.name} (${from})\n` +
        `Dates: ${fmtDate(session.ciDate)} - ${fmtDate(session.coDate)}\n` +
        `Nights: ${nights}\nRooms: ${session.rooms}\nType: ${session.roomType}\nPlan: ${session.plan}`
      );
      return;
    }

    const result = await checkAvailability({
      ciDate: session.ciDate,
      coDate: session.coDate,
      rooms: session.rooms || 1,
    });

    if (result.available) {
      session.step = "awaiting_confirm";

      const plan = session.plan;
      const extraPersonCharge = getExtraPersonCharge(plan);
      const childNoBedCharge = getChildNoBedCharge(plan);
      let rateMsg = `Dear *${agent.name}*,\n\nRooms available! Here are the rates:\n\n`;
      let grandTotal = 0;

      const roomTypesList = session.roomTypes && session.roomTypes.length > 1
        ? session.roomTypes
        : [{ type: session.roomType || "deluxe", count: session.rooms }];

      // Get cumulative tally — skip for guest bookings (BOOK1) and category "Guest"
      const isGuestBooking = session.isGuestBooking || agent.category === "Guest" || false;
      const tally = isGuestBooking ? { roomsBooked: 0, freeRoomsUsed: 0 } : await getTally(from);
      const totalRoomsThisBooking = roomTypesList.reduce((s, r) => s + r.count, 0);
      const roomsAfterBooking = isGuestBooking ? 0 : tally.roomsBooked + totalRoomsThisBooking;
      const freeRoomsAvailable = isGuestBooking ? 0 : Math.floor(tally.roomsBooked / 10) - (tally.freeRoomsUsed || 0);
      const newFreeRoomsEarned = isGuestBooking ? 0 : Math.floor(roomsAfterBooking / 10) - Math.floor(tally.roomsBooked / 10);

      // Free rooms to apply = available + newly earned
      const freeRoomsToApply = freeRoomsAvailable + newFreeRoomsEarned;
      const freeRoomRate = getRate("deluxe", "CP", session.ciDate, agent.category);
      const freeRoomValuePerNight = freeRoomRate?.rate || 0;
      const freeRoomDiscount = freeRoomsToApply > 0 ? freeRoomValuePerNight * freeRoomsToApply * nights : 0;

      for (const rt of roomTypesList) {
        const rateInfo = getRate(rt.type, plan, session.ciDate, agent.category);
        const rate = rateInfo?.rate || 0;
        const roomTotal = rate * rt.count * nights;
        grandTotal += roomTotal;
        const typeName = rt.type === "honeymoon" ? "Honeymoon" :
                        rt.type === "superdeluxe" ? "Super Deluxe" : "Deluxe";
        const gstNote = rateInfo?.isMapai ? " (GST incl.)" : "";

        rateMsg += `*${rt.count} x ${typeName}*\n`;
        rateMsg += `  Without extra bed: *Rs.${rate.toLocaleString()}/night*${gstNote}\n`;
        rateMsg += `  Extra person (above 10 yrs) with mattress: *Rs.${(rate+extraPersonCharge).toLocaleString()}/night*${gstNote}\n`;
        rateMsg += `  Child no bed (6 to 10 yrs): *Rs.${(rate+childNoBedCharge).toLocaleString()}/night*${gstNote}\n`;
        rateMsg += `  With extra bed (under 5 yrs): *Rs.${rate.toLocaleString()}/night* (FREE)\n\n`;
      }

      // Apply free room discount if available
      if (freeRoomsToApply > 0) {
        grandTotal -= freeRoomDiscount;
        session.freeRoomsApplied = freeRoomsToApply;
        session.freeRoomDiscount = freeRoomDiscount;
      } else {
        session.freeRoomsApplied = 0;
        session.freeRoomDiscount = 0;
      }

      // Show tally progress
      const roomsNeededForNext = 10 - (roomsAfterBooking % 10);

      rateMsg += `Check-in: *${fmtDate(session.ciDate)}*\n`;
      rateMsg += `Check-out: *${fmtDate(session.coDate)}*\n`;
      rateMsg += `Nights: *${nights}*\nPlan: *${plan}*\n\n`;

      if (freeRoomsToApply > 0) {
        rateMsg += `🎁 *FREE ROOM APPLIED!*\n`;
        rateMsg += `${freeRoomsToApply} Deluxe CP room${freeRoomsToApply > 1 ? "s" : ""} FREE (FY tally)\n`;
        rateMsg += `Discount: -Rs.${Math.round(freeRoomDiscount).toLocaleString()}\n`;
        rateMsg += `*Total after discount: Rs.${Math.round(grandTotal).toLocaleString()}*\n\n`;
      } else {
        rateMsg += `Total (without extra bed): *Rs.${Math.round(grandTotal).toLocaleString()}*\n`;
        if (!isGuestBooking) {
          rateMsg += `📊 FY Tally: ${tally.roomsBooked} rooms booked → ${roomsNeededForNext} more for next FREE room\n`;
        }
        rateMsg += `\n`;
      }

      if (!isGuestBooking && newFreeRoomsEarned > 0) {
        rateMsg += `🎉 This booking earns you *${newFreeRoomsEarned} FREE room${newFreeRoomsEarned > 1 ? "s" : ""}*!\n\n`;
      }

      rateMsg += `Reply *YES* to confirm or *NO* to cancel\n\n`;

      // Add upgrade options based on current room type
      const currentType = (session.roomTypes?.[0]?.type || session.roomType || "deluxe").toLowerCase();
      if (currentType.includes("deluxe") && !currentType.includes("super")) {
        const sdRate = getRate("superdeluxe", plan, session.ciDate, agent.category);
        const hmRate = getRate("honeymoon", plan, session.ciDate, agent.category);
        rateMsg += `🔼 *Upgrade options:*\n`;
        rateMsg += `Reply *SUPER* → Super Deluxe (Rs.${sdRate?.rate?.toLocaleString()}/night)\n`;
        rateMsg += `Reply *HONEY* → Honeymoon (Rs.${hmRate?.rate?.toLocaleString()}/night)\n\n`;
      } else if (currentType.includes("super")) {
        const hmRate = getRate("honeymoon", plan, session.ciDate, agent.category);
        rateMsg += `🔼 *Upgrade option:*\n`;
        rateMsg += `Reply *HONEY* → Honeymoon (Rs.${hmRate?.rate?.toLocaleString()}/night)\n\n`;
      }

      rateMsg += `---------------------------\n`;
      rateMsg += `📸 Photos: https://www.sukhsagarregency.com\n`;
      rateMsg += `📍 Location: https://maps.google.com/?q=31.078199,77.140404`;

      session.rate = grandTotal / (session.rooms * nights);
      await sendMessage(from, rateMsg);

      // ── ENQUIRY FOLLOW-UP REMINDERS ─────────────────────────────
      // Clear any existing timers
      if (session.timeoutId) clearTimeout(session.timeoutId);
      if (session.reminderIds) session.reminderIds.forEach(id => clearTimeout(id));
      session.reminderIds = [];

      // Build enquiry summary for reminders
      const enquirySummary =
        `📅 Check-in:  *${fmtDate(session.ciDate)}*\n` +
        `📅 Check-out: *${fmtDate(session.coDate)}*\n` +
        `🛏 Rooms: *${session.rooms} x ${(session.roomType || "deluxe").charAt(0).toUpperCase() + (session.roomType || "deluxe").slice(1)}*\n` +
        `🍽 Plan: *${session.plan}*\n` +
        `💰 Rate: *Rs.${Math.round(session.rate || 0).toLocaleString()}/night*`;

      // Reminder schedule: 24hr, 48hr, 72hr, 1 week
      const reminderSchedule = [
        { delay: 24 * 60 * 60 * 1000, label: "1st reminder (24hr)" },
        { delay: 48 * 60 * 60 * 1000, label: "2nd reminder (48hr)" },
        { delay: 72 * 60 * 60 * 1000, label: "3rd reminder (72hr)" },
        { delay: 7  * 24 * 60 * 60 * 1000, label: "Final reminder (1 week)" },
      ];

      reminderSchedule.forEach(({ delay, label }, idx) => {
        const isFinal = idx === reminderSchedule.length - 1;
        const timerId = setTimeout(async () => {
          try {
            if (sessions[from]?.step !== "awaiting_confirm") return; // already confirmed/cancelled

            if (!isFinal) {
              // Send follow-up reminder
              await sendMessage(from,
                `Dear *${agent.name}*,\n\n` +
                `Following up on your enquiry 🙏\n\n` +
                enquirySummary + `\n\n` +
                `Rooms are *still available*!\n` +
                `Reply *YES* to confirm or *NO* to cancel.`
              );
              console.log(`Enquiry reminder sent to ${from}: ${label}`);
            } else {
              // Final reminder — auto cancel after 1 week
              sessions[from].step = "idle";
              sessions[from].timeoutId = null;
              sessions[from].reminderIds = [];

              await sendMessage(from,
                `Dear *${agent.name}*,\n\n` +
                `Your enquiry has been *auto-cancelled* as we did not receive a response.\n\n` +
                enquirySummary + `\n\n` +
                `If you still need rooms, please send a new enquiry. 🙏`
              );

              await sendReminder(ADMIN_PHONE,
                `⚠️ *ENQUIRY AUTO-CANCELLED*\n` +
                `Agent: ${agent.name} (${from})\n` +
                enquirySummary + `\n\nNo response in 1 week.`
              );
              console.log(`Enquiry auto-cancelled for ${from} after 1 week`);
            }
          } catch(e) { console.error(`Reminder error (${label}):`, e.message); }
        }, delay);
        session.reminderIds.push(timerId);
      });

      await sendReminder(ADMIN_PHONE,
        `OK *Available*\nAgent: ${agent.name} (${from}) [Cat ${agent.category}]\n` +
        `${session.ciDate} -> ${session.coDate}\n${session.rooms} rooms | ${plan}\n` +
        `Waiting for confirmation.`
      );
    } else {
      session.step = "idle";
      await sendMessage(from,
        `Dear *${agent.name}*,\n\nSorry, rooms are not available for:\n\n` +
        `Check-in: *${fmtDate(session.ciDate)}*\n` +
        `Check-out: *${fmtDate(session.coDate)}*\n` +
        `Rooms: *${session.rooms}*\n\n` +
        `Please try different dates or room types. 🙏`
      );
      // Notify admin about the unavailability
      await sendReminder(ADMIN_PHONE,
        `🚫 *ROOMS NOT AVAILABLE*\n\n` +
        `Agent: *${agent.name}* (${from}) [Cat ${agent.category}]\n` +
        `📅 Check-in: *${fmtDate(session.ciDate)}*\n` +
        `📅 Check-out: *${fmtDate(session.coDate)}*\n` +
        `🛏 Rooms: *${session.rooms} x ${session.roomType || "Deluxe"}*\n` +
        `🍽 Plan: *${session.plan || "—"}*\n\n` +
        `Agent was informed to try different dates.`
      );
    }
  } catch (err) {
    console.error("checkAndRespond error:", err.message);
    await sendMessage(from, `Dear *${agent.name}*, sorry there was an error. Please try again.`);
  }
}

async function confirmAndSave(from, agent, session) {
  try {
    const ciFormatted = session.ciDate || "";
    const coFormatted = session.coDate || "";
    const pmsRoomType = session.roomType === "honeymoon" ? "Honeymoon" :
                        session.roomType === "superdeluxe" ? "Super Deluxe" : "Deluxe";

    const stayezeeRes = await saveReservation({
      guestName: session.guestName || "Guest",
      guestMobile: session.guestMobile || from,
      male: 1, female: 0, kids: 0,
      plan: session.plan || "CP",
      tariff: 1, // Rate hidden from Stayezee - real rate sent to admin
      extra_bed: session.extraBed || 0,
      extra_bed_charge: 0, // Hidden from Stayezee
      rooms: session.rooms || 1,
      checkinDate: ciFormatted,
      checkoutDate: coFormatted,
      roomType: pmsRoomType,
    });

    if (!stayezeeRes?.success) {
      console.error("Stayezee reservation was not saved:", stayezeeRes);
      await sendMessage(from,
        `Booking could not be saved in PMS right now. Please contact hotel admin before confirming this booking.`
      );
      await sendReminder(ADMIN_PHONE,
        `PMS SAVE FAILED\nAgent: ${agent.name} (${from})\nGuest: ${session.guestName || "Guest"} (${session.guestMobile || from})\n` +
        `Dates: ${fmtDate(session.ciDate)} - ${fmtDate(session.coDate)}\nRooms: ${session.rooms || 1}\nPlan: ${session.plan || "CP"}\n` +
        `Error: ${stayezeeRes?.error || JSON.stringify(stayezeeRes)}`
      );
      session.step = "idle";
      return;
    }

    // Get Stayezee confirmation number
    const stayezeeData = stayezeeRes?.data;
    const confirmNo = stayezeeData?.booking_id || stayezeeData?.confirmation_no || 
                      stayezeeData?.reservation_no || stayezeeData?.id || 
                      stayezeeData?.message || "Generated";
    // Store stayezee ID for potential cancellation
    session.stayezeeId = stayezeeData?.booking_id || stayezeeData?.id || stayezeeData?.reservation_no || null;

    const nights = session.nights || 1;
    const rooms = session.rooms || 1;
    const rate = session.rate || 0;
    const extraCharge = (session.extraBedCharge || 0) * nights;
    const roomTotal = rate * rooms * nights;
    const freeRoomDiscount = session.freeRoomDiscount || 0;
    const freeRoomsApplied = session.freeRoomsApplied || 0;
    // Use pre-calculated grandTotal if admin set it (avoids recalculation errors)
    const grandTotal = session.grandTotal
      ? session.grandTotal + extraCharge - freeRoomDiscount
      : roomTotal + extraCharge - freeRoomDiscount;

    // Build room display string — use roomTypes if multiple types
    const roomTypesList2 = session.roomTypes && session.roomTypes.length > 1
      ? session.roomTypes
      : null;
    const typeName = roomTypesList2
      ? roomTypesList2.map(r => `${r.count} x ${r.type === "honeymoon" ? "Honeymoon" : r.type === "superdeluxe" ? "Super Deluxe" : "Deluxe"}`).join(" + ")
      : pmsRoomType;
    const roomsDisplay = roomTypesList2
      ? roomTypesList2.map(r => `${r.count} x ${r.type === "honeymoon" ? "Honeymoon" : r.type === "superdeluxe" ? "Super Deluxe" : "Deluxe"}`).join(" + ")
      : `${rooms} x ${pmsRoomType}`;

    // Generate voucher number
    const now = new Date();
    const voucherNo = "SR-" + String(now.getDate()).padStart(2,"0") +
                      String(now.getMonth()+1).padStart(2,"0") +
                      now.getFullYear() + "-" +
                      String(Math.floor(Math.random()*9000)+1000);

    // WhatsApp VOUCHER to agent
    let voucherMsg =
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏨 HOTEL SUKHSAGAR REGENCY\n` +
      `      BOOKING VOUCHER\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Voucher No: *${voucherNo}*\n` +
      `Date: *${fmtDate(now.toISOString().split("T")[0])}*\n\n` +
      `*AGENT DETAILS*\n` +
      `Agent: ${agent.name}\n` +
      `Phone: ${from}\n\n` +
      `*GUEST DETAILS*\n` +
      `Guest: *${session.guestName}*\n` +
      `Mobile: ${session.guestMobile}\n\n` +
      `*BOOKING DETAILS*\n` +
      `Check-in:  *${fmtDate(session.ciDate)}*\n` +
      `Check-out: *${fmtDate(session.coDate)}*\n` +
      `Nights:    *${nights}*\n` +
      `Rooms:     *${roomsDisplay}*\n` +
      `Adults:    *${session.adults || 1}*\n` +
      `Kids:      *${session.kids || 0}${session.kidAges ? ` (${session.kidAges.join(", ")} yrs)` : ""}*\n` +
      `Plan:      *${session.plan}*\n`;

    if (session.extraBed) {
      voucherMsg += `Extra bed: *${session.extraBedType}*\n`;
    } else {
      voucherMsg += `Extra bed: None\n`;
    }

    voucherMsg +=
      `\n*AMOUNT*\n` +
      `Rate:  Rs.${Math.round(rate).toLocaleString()}/night\n`;

    if (extraCharge > 0) {
      voucherMsg += `Extra: Rs.${Math.round(extraCharge).toLocaleString()}\n`;
    }

    if (freeRoomsApplied > 0) {
      voucherMsg += `🎁 Free Room (${freeRoomsApplied} Deluxe CP): -Rs.${Math.round(freeRoomDiscount).toLocaleString()}\n`;
    }

    voucherMsg +=
      `*Total: Rs.${Math.round(grandTotal).toLocaleString()}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `Hotel Sukhsagar Regency\n` +
      `Shimla, Himachal Pradesh\n` +
      `📞 +91 98160 03322\n` +
      `━━━━━━━━━━━━━━━━━━━━━` +
      (session.remark ? `\n\n📝 *Remark:* ${session.remark}` : "");

    // Guests added by admin — use approved template (works for any number)
    // Agents — send full voucher text
    if (agent.category === "Guest") {
      await sendConfirmed(from, {
        ciDate: session.ciDate,
        coDate: session.coDate,
        rooms: session.rooms || 1,
        plan: session.plan || "CP",
        rate: Math.round(session.rate || 0),
        confirmationNumber: confirmNo
      });
    } else {
      await sendMessage(from, voucherMsg);
    }

    // Generate and send PDF voucher
    try {
      const { generateVoucher } = require("./generate-voucher");
      const axios = require("axios");
      const fs = require("fs");
      const FormData = require("form-data");

      const pdfPath = await generateVoucher({
        voucherNo, date: fmtDate(now.toISOString().split("T")[0]),
        agentName: agent.name, agentPhone: from,
        guestName: session.guestName, guestMobile: session.guestMobile,
        ciDate: fmtDate(session.ciDate), coDate: fmtDate(session.coDate),
        nights, rooms, roomType: typeName, plan: session.plan,
        extraBed: session.extraBed, extraBedType: session.extraBedType,
        rate, roomTotal, extraCharge, grandTotal
      });

      // Send PDF via WhatsApp
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("recipient_type", "individual");
      form.append("to", from);
      form.append("type", "document");
      form.append("document[caption]", `Booking Voucher - ${voucherNo}`);
      form.append("document[filename]", `Voucher-${voucherNo}.pdf`);
      form.append("document[document]", fs.createReadStream(pdfPath), {
        contentType: "application/pdf",
        filename: `Voucher-${voucherNo}.pdf`
      });

      // First upload media
      const uploadForm = new FormData();
      uploadForm.append("messaging_product", "whatsapp");
      uploadForm.append("file", fs.createReadStream(pdfPath), {
        contentType: "application/pdf",
        filename: `Voucher-${voucherNo}.pdf`
      });
      uploadForm.append("type", "application/pdf");

      const uploadRes = await axios.post(
        `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/media`,
        uploadForm,
        { headers: { 
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          ...uploadForm.getHeaders()
        }}
      );

      const mediaId = uploadRes.data?.id;
      if (mediaId) {
        await axios.post(
          `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: from,
            type: "document",
            document: {
              id: mediaId,
              caption: `Booking Voucher - ${voucherNo}`,
              filename: `Voucher-${voucherNo}.pdf`
            }
          },
          { headers: { 
            Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          }}
        );
        console.log("PDF voucher sent via WhatsApp");
      }

      // Attach PDF to email too
      session._pdfPath = pdfPath;
    } catch(pdfErr) {
      console.error("PDF error:", pdfErr.message);
    }


    // Send WhatsApp notification to admin
    const adminMsg =
      `NEW BOOKING CONFIRMED!\n\n` +
      `Confirmation No: ${confirmNo}\n` +
      `Agent: ${agent.name} (${from})\n` +
      `Guest: ${session.guestName} (${session.guestMobile})\n` +
      `Check-in: ${fmtDate(session.ciDate)}\n` +
      `Check-out: ${fmtDate(session.coDate)}\n` +
      `Nights: ${nights}\n` +
      `Rooms: ${roomsDisplay}\n` +
      `Plan: ${session.plan}\n` +
      `Total: Rs.${Math.round(grandTotal).toLocaleString()}`;

    // Update financial year tally — skip for guest bookings
    try {
      if (session.isGuestBooking) { console.log("Guest booking — skipping tally update"); throw new Error("skip"); }
      const tallyResult = await updateTally(from, agent.name, rooms);
      if (session.freeRoomsApplied > 0) {
        await useFreeRooms(from, agent.name, session.freeRoomsApplied);
      }
      // Notify agent about tally
      const roomsNeededForNext = 10 - (tallyResult.newRooms % 10);
      let tallyMsg = `📊 *Your FY Booking Tally:*\n`;
      tallyMsg += `Total rooms booked this year: *${tallyResult.newRooms}*\n`;
      if (session.freeRoomsApplied > 0) {
        tallyMsg += `Free rooms used: *${session.freeRoomsApplied}*\n`;
      }
      if (tallyResult.newlyEarned > 0) {
        tallyMsg += `🎁 *${tallyResult.newlyEarned} new FREE room${tallyResult.newlyEarned > 1 ? "s" : ""} earned!*\n`;
      }
      if (roomsNeededForNext < 10) {
        tallyMsg += `Next free room in: *${roomsNeededForNext} more room${roomsNeededForNext > 1 ? "s" : ""}*`;
      }
      await sendReminder(from, tallyMsg);

      // Update admin msg with tally
      const adminTallyNote = `\nFY Tally: ${tallyResult.newRooms} rooms | Free rooms used: ${session.freeRoomsApplied || 0}`;
      await sendReminder(ADMIN_PHONE, adminMsg + adminTallyNote);
    } catch(tallyErr) {
      console.error("Tally update error:", tallyErr.message);
      await sendReminder(ADMIN_PHONE, adminMsg);
    }

    // ── PAYMENT POLICY ──────────────────────────────────────────
    // If check-in < 15 days away: 50% now + 50% at check-in
    // If check-in >= 15 days away: 25% token + 35% (15 days before) + 40% at check-in
    try {
      const UPI_ID = process.env.UPI_ID || "9816003322@okbizaxis";
      const today = new Date();
      today.setHours(0,0,0,0);
      const ciDate = new Date(session.ciDate);
      const daysToCheckin = Math.round((ciDate - today) / 86400000);
      const total = Math.round(grandTotal);

      let firstAmount, paymentSchedule, policyNote;

      if (daysToCheckin < 15) {
        // Short notice — 50% now, 50% at check-in
        firstAmount = Math.round(total * 0.50);
        const atCheckin = total - firstAmount;
        paymentSchedule = [
          { label: "50% Advance (Now)", amount: firstAmount, due: "Pay now to confirm" },
          { label: "50% Balance", amount: atCheckin, due: "At check-in" },
        ];
        policyNote =
          `⚠️ *Check-in is within 15 days*\n` +
          `50% advance required to confirm booking.\n\n` +
          `💰 *Payment Schedule:*\n` +
          `• Pay Now (50%): *Rs.${firstAmount.toLocaleString()}*\n` +
          `• At Check-in (50%): Rs.${atCheckin.toLocaleString()}`;
      } else {
        // Normal — 25% token + 35% (15 days before) + 40% at check-in
        firstAmount = Math.round(total * 0.25);
        const secondAmount = Math.round(total * 0.35);
        const thirdAmount = total - firstAmount - secondAmount;
        const reminderDate = new Date(ciDate);
        reminderDate.setDate(reminderDate.getDate() - 15);
        const reminderStr = reminderDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        paymentSchedule = [
          { label: "25% Token (Now)", amount: firstAmount, due: "Pay now to confirm" },
          { label: "35% Second Payment", amount: secondAmount, due: `By ${reminderStr}` },
          { label: "40% Balance", amount: thirdAmount, due: "At check-in" },
        ];
        policyNote =
          `💰 *Payment Schedule:*\n` +
          `• Token (25%): *Rs.${firstAmount.toLocaleString()}* — Pay now\n` +
          `• 2nd Payment (35%): Rs.${secondAmount.toLocaleString()} — By ${reminderStr}\n` +
          `• Balance (40%): Rs.${thirdAmount.toLocaleString()} — At check-in`;
      }

      // Store pending payment with full schedule
      pendingPayments[from] = {
        agentName: agent.name,
        agentPhone: from,
        amount: firstAmount,
        total,
        remaining: total - firstAmount,
        voucherNo,
        ciDate: session.ciDate,
        coDate: session.coDate,
        guestName: session.guestName,
        roomType: session.roomType || "deluxe",
        rooms: session.rooms || 1,
        plan: session.plan || "CP",
        paymentSchedule,
        daysToCheckin,
        paidSoFar: 0,
        paymentStep: 1,
        stayezeeId: session.stayezeeId || null,
      };

      // Send QR for first payment — high resolution for gallery scanning
      const upiLink = `upi://pay?pa=${UPI_ID}&pn=Hotel%20Sukhsagar%20Regency&am=${firstAmount}&cu=INR&tn=Advance-${voucherNo}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&ecc=H&margin=2&data=${encodeURIComponent(upiLink)}`;
      const axios = require("axios");

      await axios.post(
        `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: from,
          type: "image",
          image: {
            link: qrUrl,
            caption:
              `💳 *PAYMENT REQUEST*\n\n` +
              `Voucher: *${voucherNo}*\n` +
              `Total Booking: *Rs.${total.toLocaleString()}*\n\n` +
              policyNote + `\n\n` +
              `UPI ID: *${UPI_ID}*\n` +
              `Amount: *Rs.${firstAmount.toLocaleString()}*\n\n` +
              `📱 *To pay on mobile:*\n` +
              `Open GPay/PhonePe → Scan QR\n` +
              `Or pay directly to UPI ID: *${UPI_ID}*\n\n` +
              `📸 After payment send screenshot here to confirm booking.`
          }
        },
        { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );

      // Also send clickable UPI payment link as separate text message
      await sendMessage(from,
        `💡 *Quick Pay Link:*\n` +
        `If QR doesn\'t scan, pay directly:\n\n` +
        `UPI ID: *${UPI_ID}*\n` +
        `Amount: *Rs.${firstAmount.toLocaleString()}*\n` +
        `Reference: ${voucherNo}\n\n` +
        `Open GPay/PhonePe → Send Money → Enter UPI ID above`
      );
      console.log("Payment QR sent to agent", from, `(${daysToCheckin} days to checkin)`);

      // ── PAYMENT FOLLOW-UP REMINDERS ──────────────────────────────
      // 24hr, 48hr, 72hr reminders + 1 week auto-cancel
      const paymentReminderSchedule = [
        { delay: 24 * 60 * 60 * 1000, label: "24hr payment reminder" },
        { delay: 48 * 60 * 60 * 1000, label: "48hr payment reminder" },
        { delay: 72 * 60 * 60 * 1000, label: "72hr payment reminder" },
        { delay: 7 * 24 * 60 * 60 * 1000, label: "1 week auto-cancel" },
      ];

      paymentReminderSchedule.forEach(({ delay, label }, idx) => {
        const isFinal = idx === paymentReminderSchedule.length - 1;
        setTimeout(async () => {
          try {
            // Check if payment already received
            if (!pendingPayments[from] || pendingPayments[from].voucherNo !== voucherNo) return;

            if (!isFinal) {
              // Send payment reminder with QR
              const reminderUpiLink = `upi://pay?pa=${UPI_ID}&pn=Hotel%20Sukhsagar%20Regency&am=${firstAmount}&cu=INR&tn=Advance-${pending.voucherNo || voucherNo}`;
              const reminderQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&ecc=H&margin=2&data=${encodeURIComponent(reminderUpiLink)}`;
              const axiosLib = require("axios");
              await axiosLib.post(
                `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
                {
                  messaging_product: "whatsapp",
                  recipient_type: "individual",
                  to: from,
                  type: "image",
                  image: {
                    link: reminderQrUrl,
                    caption:
                      `⏰ *PAYMENT REMINDER*\n\n` +
                      `Voucher: *${voucherNo}*\n` +
                      `Guest: ${session.guestName}\n` +
                      `Check-in: ${fmtDate(session.ciDate)}\n\n` +
                      policyNote + `\n\n` +
                      `UPI ID: *${UPI_ID}*\n\n` +
                      `📸 Please pay and send screenshot to confirm booking.`
                  }
                },
                { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
              );
              console.log(`Payment reminder sent to ${from}: ${label}`);
            } else {
              // Auto-cancel booking after 1 week of no payment
              const stayezeeId = pendingPayments[from]?.stayezeeId;
              delete pendingPayments[from];

              // Cancel in Stayezee
              if (stayezeeId) {
                try {
                  await cancelReservation(stayezeeId);
                  console.log(`Stayezee reservation ${stayezeeId} cancelled for ${from}`);
                } catch(e) { console.error("Stayezee cancel error:", e.message); }
              }

              // Notify agent
              await sendReminder(from,
                `❌ *BOOKING CANCELLED*\n\n` +
                `Voucher: *${voucherNo}*\n` +
                `Guest: ${session.guestName}\n` +
                `Check-in: ${fmtDate(session.ciDate)}\n\n` +
                `Your booking has been *auto-cancelled* due to non-payment.\n\n` +
                `Please contact hotel to re-book:\n📞 +91 98160 03322`
              );

              // Notify admin
              await sendReminder(ADMIN_PHONE,
                `❌ *BOOKING AUTO-CANCELLED (No Payment)*\n\n` +
                `Agent: ${agent.name} (${from})\n` +
                `Voucher: ${voucherNo}\n` +
                `Guest: ${session.guestName}\n` +
                `Check-in: ${fmtDate(session.ciDate)}\n` +
                `Amount due: Rs.${firstAmount.toLocaleString()}\n\n` +
                `Booking cancelled after 1 week of no payment.`
              );
              console.log(`Booking auto-cancelled for ${from}: ${voucherNo}`);
            }
          } catch(e) { console.error(`Payment reminder error (${label}):`, e.message); }
        }, delay);
      });

      // For guests — also send text fallback
      if (agent.category === "Guest") {
        try {
          await sendReminder(from,
            `💳 *PAYMENT REQUEST*\n\n` +
            `Voucher: ${voucherNo}\n` +
            `Total: Rs.${total.toLocaleString()}\n\n` +
            policyNote + `\n\n` +
            `UPI ID: *${UPI_ID}*\n\n` +
            `Please pay and send screenshot to confirm booking.`
          );
        } catch(e) { console.error("Guest payment text error:", e.message); }
      }

      // Store reminder date in pendingPayments — checked daily by cron
      // We store the date instead of using setTimeout (which resets on server restart)
      if (daysToCheckin >= 15) {
        const reminderDate = new Date(ciDate);
        reminderDate.setDate(reminderDate.getDate() - 15);
        // Store reminder date on pendingPayments for daily cron check
        if (pendingPayments[from]) {
          pendingPayments[from].secondPaymentReminderDate = reminderDate.toISOString().split("T")[0];
          pendingPayments[from].secondPaymentAmount = Math.round(total * 0.35);
        }
        console.log(`2nd payment reminder set for ${reminderDate.toLocaleDateString()} for ${from}`);
      }
    } catch(qrErr) {
      console.error("QR send error:", qrErr.message);
    }

    // Send email to hotel
    try {
      const axios = require("axios");
      const PMS_URL = process.env.PMS_URL || "https://hotelease-pms.onrender.com";
      const bookingEmailTo = "sukhsagarregencysml@gmail.com";
      console.log("Booking email: preparing PMS email request", {
        to: bookingEmailTo,
        url: PMS_URL + "/api/reservations/send-booking-email"
      });
      await axios.post(PMS_URL + "/api/reservations/send-booking-email", {
        to: bookingEmailTo,
        confirmNo,
        agentName: agent.name,
        agentPhone: from,
        guestName: session.guestName,
        guestMobile: session.guestMobile,
        ciDate: fmtDate(session.ciDate),
        coDate: fmtDate(session.coDate),
        nights,
        rooms,
        roomType: typeName,
        adults: session.adults || 1,
        kids: session.kids || 0,
        kidAges: session.kidAges || [],
        plan: session.plan,
        rate: Math.round(rate),
        total: Math.round(grandTotal),
      });
      console.log("Booking email sent to hotel via PMS", { to: bookingEmailTo });
    } catch(emailErr) {
      console.error("Email error:", emailErr.message, emailErr.stack);
    }

    sessions[from] = { step: "idle" };
  } catch (err) {
    console.error("confirmAndSave error:", err.message);
    await sendMessage(from, "Booking confirmed! (Note: Please verify with hotel directly)");
    sessions[from] = { step: "idle" };
  }
}

// -- AGENT MENU HELPER --------------------------------------------------
async function sendAgentMenu(from, agentName) {
  await sendMessage(from,
    `Dear *${agentName}*,\n\nWelcome to Hotel Sukhsagar Regency! 🏨\n\n` +
    `*To check availability & rates, send:*\n` +
    `*[rooms] [type] [plan] [dates]*\n\n` +
    `Examples:\n` +
    `• 2 deluxe CP 10 july 12 july\n` +
    `• 2 dlx 1 honey MAP c/in 10july c/out 12july\n` +
    `• 3 sdlx MAPAI 10aug 2nights\n\n` +
    `Room types: *deluxe/dlx, super deluxe/sdlx, honeymoon/honey*\n` +
    `Plans: *CP, MAP, MAPAI, EP*\n\n` +
    `*Other options:*\n` +
    `*2* - Hotel photos\n` +
    `*3* - Breakfast menu\n` +
    `*4* - Location\n` +
    `*5* - Contact us\n\n` +
    `Reply *HELP* anytime to see this message.`
  );
}

// -- GUEST FLOW -----------------------------------------------------------
async function handleGuest(from, text, t) {
  const session = guestSessions[from] || { step: "start" };
  guestSessions[from] = session;

  // Show main menu
  if (["HI","HELLO","START","MENU","0","HOME","1","2","3","4","5"].includes(t) || session.step === "start") {
    if (t === "1" || session.pendingMenu === "1") {
      // Ask for dates directly
      await sendMessage(from,
        `Please share your stay details to check availability:\n\n` +
        `Example:\n` +
        `*22 July to 24 July, 2 adults, Deluxe, CP*\n\n` +
        `Room types: Deluxe, Super Deluxe, Honeymoon\n` +
        `Plans: CP (Breakfast) | MAP (Breakfast+Dinner) | EP (Room only)\n\n` +
        `Reply *0* to go back to menu.`
      );
      session.step = "enquiry";
      return;
    }
    if (t === "2") {
      // Photos
      await sendMessage(from,
        `View our hotel photos here:\n\n` +
        `🖼 ${HOTEL_INFO.photos}\n\n` +
        `Reply *0* to go back to menu.`
      );
      session.step = "start";
      return;
    }
    if (t === "3") {
      // Menu
      await sendMessage(from,
        `*Hotel Sukhsagar Regency*\n` +
        `*Breakfast Menu*\n` +
        `---------------------------\n` +
        `Butter and jam toast\n` +
        `Cornflakes with milk\n` +
        `Tea and coffee\n` +
        `Upma or poha\n` +
        `Vada sambar or idli sambar\n` +
        `Parantha with curd or poori bhaji\n` +
        `Omelette or egg bhurji\n` +
        `Fresh fruit\n` +
        `Concentrate juice\n` +
        `Pastry muffin\n\n` +
        `Breakfast timings: *7:30 AM - 10:30 AM*\n\n` +
        `Reply *0* to go back to menu.`
      );
      session.step = "start";
      return;
    }
    if (t === "4") {
      // Location
      await sendMessage(from,
        `Find us here:\n\n` +
        `📍 *${HOTEL_INFO.name}*\n` +
        `${HOTEL_INFO.location}\n\n` +
        `Google Maps: ${HOTEL_INFO.googleMaps}\n\n` +
        `Check-in time: ${HOTEL_INFO.checkIn}\n` +
        `Check-out time: ${HOTEL_INFO.checkOut}\n\n` +
        `Reply *0* to go back to menu.`
      );
      session.step = "start";
      return;
    }
    if (t === "5") {
      // Contact
      await sendMessage(from,
        `Contact us:\n\n` +
        `📞 *${HOTEL_INFO.phone}*\n` +
        `📍 ${HOTEL_INFO.location}\n\n` +
        `Reply *0* to go back to menu.`
      );
      session.step = "start";
      return;
    }

    // Default - show menu
    await sendMessage(from,
      `Welcome to *${HOTEL_INFO.name}*! 🏨\n\n` +
      `How can we help you?\n\n` +
      `Reply with a number:\n` +
      `*1* - Room availability & rates\n` +
      `*2* - Hotel photos\n` +
      `*3* - Restaurant menu\n` +
      `*4* - Location & directions\n` +
      `*5* - Contact us\n\n` +
      `Or share your *Booking ID* to get your booking details.`
    );
    session.step = "menu";
    return;
  }

  // Handle enquiry step — parse dates and show availability
  if (session.step === "enquiry" || session.step === "awaiting_plan" || 
      session.step === "awaiting_confirm_customer") {

    // Awaiting plan
    if (session.step === "awaiting_plan") {
      const planMap = { CP: "CP", MAP: "MAP", MAPAI: "MAPAI", EP: "EP" };
      const planInput = t.trim().toUpperCase();
      if (planMap[planInput]) {
        session.plan = planMap[planInput];
        session.step = "awaiting_confirm_customer";
      } else {
        await sendMessage(from, `Please reply with:\n*CP* - With Breakfast\n*MAP* - Breakfast & Dinner\n*MAPAI* - All Inclusive\n*EP* - Room Only`);
        return;
      }
    }

    // Parse enquiry
    if (session.step === "enquiry") {
      const { parseEnquiry } = require("./parser");
      const parsed = parseEnquiry(text);
      if (!parsed || !parsed.ciDate) {
        await sendMessage(from,
          `Please share your dates like:\n` +
          `*22 July to 24 July, 2 adults, Deluxe, CP*\n\n` +
          `Reply *0* for main menu.`
        );
        return;
      }
      session.ciDate = parsed.ciDate;
      session.coDate = parsed.coDate;
      session.rooms = parsed.rooms || 1;
      session.roomType = parsed.roomType || "deluxe";
      session.adults = parsed.adults || 2;
      session.kids = parsed.kids || 0;
      session.plan = parsed.plan;

      if (!session.plan) {
        await sendMessage(from,
          `Which meal plan?\n\n` +
          `*CP* - With Breakfast\n` +
          `*MAP* - Breakfast & Dinner\n` +
          `*MAPAI* - All Inclusive\n` +
          `*EP* - Room Only`
        );
        session.step = "awaiting_plan";
        return;
      }
      session.step = "awaiting_confirm_customer";
    }

    // Show rate and ask for confirm
    if (session.step === "awaiting_confirm_customer") {
      const { checkAvailability, saveReservation, cancelReservation } = require("./stayezee");
      const avail = await checkAvailability({ ciDate: session.ciDate, coDate: session.coDate, rooms: session.rooms });

      if (!avail.available) {
        await sendMessage(from,
          `Sorry, rooms are not available for selected dates.\n\n` +
          `Please try different dates or contact us:\n📞 *${HOTEL_INFO.phone}*`
        );
        // Notify admin about guest unavailability query
        await sendReminder(ADMIN_PHONE,
          `🚫 *ROOMS NOT AVAILABLE (GUEST)*\n\n` +
          `Guest: *${from}*\n` +
          `📅 Check-in: *${fmtDate(session.ciDate)}*\n` +
          `📅 Check-out: *${fmtDate(session.coDate)}*\n` +
          `🛏 Rooms: *${session.rooms} x ${session.roomType || "Deluxe"}*\n` +
          `🍽 Plan: *${session.plan || "—"}*\n\n` +
          `Guest was asked to try different dates or call hotel.`
        );
        session.step = "enquiry";
        return;
      }

      const rateInfo = getCustomerRate(session.roomType, session.plan, session.ciDate);
      if (!rateInfo) {
        await sendMessage(from, `Could not find rate. Please contact us:\n📞 *${HOTEL_INFO.phone}*`);
        return;
      }

      const nights = Math.max(1, Math.round((new Date(session.coDate) - new Date(session.ciDate)) / 86400000));
      session.rate = rateInfo.rate;
      session.nights = nights;
      const grandTotal = rateInfo.rate * session.rooms * nights;
      session.grandTotal = grandTotal;

      const pmsRoomType = session.roomType === "honeymoon" ? "Honeymoon" :
                          session.roomType === "superdeluxe" ? "Super Deluxe" : "Deluxe";

      // Use correct customer extra charges from rates.js (plan-dependent)
      const isMapPlan = ["MAP","MAPAI"].includes((session.plan || "").toUpperCase());
      const extraPerson = isMapPlan ? CUSTOMER_EXTRAS.mapaicwb : CUSTOMER_EXTRAS.cpaicwb;
      const childNoBedAbove5 = CUSTOMER_EXTRAS.cnbAbove5;
      const childNoBedBelow5 = CUSTOMER_EXTRAS.cnbBelow5;
      await sendMessage(from,
        `✅ *Rooms Available!*\n\n` +
        `📅 Check-in:  *${fmtDate(session.ciDate)}*\n` +
        `📅 Check-out: *${fmtDate(session.coDate)}*\n` +
        `🌙 Nights:    *${nights}*\n` +
        `🛏 Room:      *${session.rooms} x ${pmsRoomType}*\n` +
        `🍽 Plan:      *${session.plan}*\n` +
        `💰 Rate:      *Rs.${rateInfo.rate.toLocaleString()}/night*\n` +
        `👤 Extra person (above 10 yrs): *Rs.${CUSTOMER_EXTRAS.extraPerson}/night*\n` +
        `🧒 Child with bed: *Rs.${extraPerson}/night*\n` +
        `🧒 Child no bed (above 5 yrs): *Rs.${childNoBedAbove5}/night*\n` +
        `🧒 Child no bed (below 5 yrs): *Rs.${childNoBedBelow5}/night*\n` +
        `💳 Total:     *Rs.${grandTotal.toLocaleString()}*\n\n` +
        `To confirm booking reply *YES*\n` +
        `To change dates reply *NO*\n` +
        `Reply *0* for main menu.`
      );
      session.step = "confirm_customer";
      return;
    }
  }

  // Customer confirms booking
  if (session.step === "confirm_customer") {
    if (["YES","Y","CONFIRM","OK","HAAN","HA"].includes(t)) {
      await sendMessage(from, `Please share your *full name*:`);
      session.step = "customer_name";
      return;
    }
    if (["NO","N","NAHI","CHANGE"].includes(t)) {
      await sendMessage(from, `Please send your new dates:\nExample: *22 July to 24 July, 2 adults, Deluxe, CP*`);
      session.step = "enquiry";
      return;
    }
  }

  // Get customer name
  if (session.step === "customer_name") {
    session.guestName = text.trim();
    await sendMessage(from, `Thank you *${session.guestName}*! Please share your *mobile number*:`);
    session.step = "customer_mobile";
    return;
  }

  // Get customer mobile
  if (session.step === "customer_mobile") {
    const mobile = text.replace(/\D/g, "");
    session.guestMobile = mobile.startsWith("91") ? mobile : "91" + mobile;

    // Create fake agent for customer (category C rates already applied)
    const fakeAgent = { name: session.guestName, phone: from, category: "C" };

    await sendMessage(from, `⏳ Confirming your booking...`);

    try {
      await confirmAndSave(from, fakeAgent, {
        ciDate: session.ciDate,
        coDate: session.coDate,
        roomType: session.roomType,
        rooms: session.rooms,
        plan: session.plan,
        rate: session.rate,
        nights: session.nights,
        adults: session.adults || 2,
        kids: session.kids || 0,
        guestName: session.guestName,
        guestMobile: session.guestMobile,
        extraBed: 0,
        extraBedCharge: 0,
        extraBedType: null,
      });
      guestSessions[from] = { step: "start" };
    } catch(err) {
      console.error("Customer booking error:", err.message);
      await sendMessage(from,
        `Sorry, booking could not be confirmed right now.\n\n` +
        `Please contact us:\n📞 *${HOTEL_INFO.phone}*`
      );
    }
    return;
  }

  // Check for booking ID
  const bookingIdMatch = text.match(/HE\d+/i);
  if (bookingIdMatch) {
    try {
      const axios = require("axios");
      const API = process.env.PMS_URL || "https://hotelease-pms.onrender.com";
      const res = await axios.get(`${API}/api/reservations/${bookingIdMatch[0].toUpperCase()}`);
      const booking = res.data?.data;

      if (!booking) {
        await sendMessage(from, `Sorry, booking *${bookingIdMatch[0].toUpperCase()}* not found. Please check and try again.`);
        return;
      }

      optedInGuests[from] = true;
      await sendMessage(from,
        `Hello ${booking.guest_name || "Guest"}! 👋\n\n` +
        `Found your booking at *${booking.hotel_name}*\n\n` +
        `Booking ID: *${booking.reservation_no}*\n` +
        `Check-in: *${fmtDate(booking.checkin_date)}*\n` +
        `Check-out: *${fmtDate(booking.checkout_date)}*\n` +
        `Room: *${booking.room_type_name}*\n` +
        `Plan: *${booking.plan}*\n\n` +
        `You will receive check-in details on this number.\n\n` +
        `Reply *0* for main menu.`
      );
    } catch (err) {
      await sendMessage(from, `Could not find booking. Please check your Booking ID.\n\nReply *0* for main menu.`);
    }
    session.step = "start";
    return;
  }

  // Menu option selected
  if (session.step === "menu" && ["1","2","3","4","5"].includes(t)) {
    guestSessions[from] = { step: "start", pendingMenu: t };
    await handleGuest(from, text, t);
    return;
  }

  // Default - show menu
  await sendMessage(from,
    `Welcome to *${HOTEL_INFO.name}*! 🏨\n\n` +
    `Reply with:\n` +
    `*1* - Room availability & rates\n` +
    `*2* - Hotel photos\n` +
    `*3* - Restaurant menu\n` +
    `*4* - Location & directions\n` +
    `*5* - Contact us\n\n` +
    `Or share your *Booking ID* for booking details.`
  );
  session.step = "menu";
}

// ── BLAST BATCH RUNNER — sends up to 50 messages, retries failed ones ───────
async function runBlastBatch(adminPhone) {
  if (!blastQueue.message) return;

  // Only send between 9 AM and 5 PM IST
  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hour = nowIST.getHours();
  if (hour < 9 || hour >= 17) {
    console.log(`Blast: outside sending hours (${hour}:00 IST). Will retry at 10 AM.`);
    if (adminPhone && blastQueue.todaySent === 0) {
      // Only notify if nothing sent today yet
    }
    return;
  }

  // Reset daily counter if it's a new day
  const today = new Date().toISOString().split("T")[0];
  if (blastQueue.lastResetDate !== today) {
    blastQueue.todaySent = 0;
    blastQueue.lastResetDate = today;
    // Move failed numbers back to pending for retry
    if (blastQueue.failed.length > 0) {
      console.log(`♻️ Blast: retrying ${blastQueue.failed.length} failed numbers`);
      blastQueue.pending = [...blastQueue.failed, ...blastQueue.pending];
      blastQueue.failed = [];
    }
  }

  const DAILY_LIMIT = 50;
  const PER_RUN_LIMIT = 7; // ~7 per hour x 8 hours = ~50/day, spread naturally
  const remaining = Math.min(PER_RUN_LIMIT, DAILY_LIMIT - blastQueue.todaySent);
  if (remaining <= 0) {
    console.log(`Blast: daily limit reached (${blastQueue.todaySent}/${DAILY_LIMIT})`);
    return;
  }

  // Take up to `remaining` numbers from pending
  const batch = blastQueue.pending.splice(0, remaining);
  if (batch.length === 0) {
    // All done!
    if (blastQueue.failed.length === 0) {
      blastQueue.message = null;
      if (adminPhone) {
        await sendMessage(adminPhone,
          `🎉 *Blast Campaign Complete!*\n\n` +
          `✅ Total sent: *${blastQueue.sentCount}*\n` +
          `All messages delivered successfully.`
        );
      }
    }
    return;
  }

  let batchSent = 0, batchFailed = 0;
  for (const phone of batch) {
    try {
      await sendMessage(phone, blastQueue.message);
      blastQueue.sentCount++;
      blastQueue.todaySent++;
      batchSent++;
      // 1.2 sec gap between messages to stay safe
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`Blast failed for ${phone}:`, err.message);
      blastQueue.failed.push(phone); // retry tomorrow
      batchFailed++;
    }
  }

  console.log(`✓ Blast batch: ${batchSent} sent, ${batchFailed} failed. Pending: ${blastQueue.pending.length}`);

  // Notify admin of batch result
  if (adminPhone) {
    const pendingLeft = blastQueue.pending.length;
    const daysLeft = Math.ceil(pendingLeft / 50);
    await sendMessage(adminPhone,
      `📊 *Blast Update*\n\n` +
      `✅ Sent today: *${blastQueue.todaySent}/50*\n` +
      `📨 Total sent: *${blastQueue.sentCount}*\n` +
      (batchFailed > 0 ? `❌ Failed (retry tomorrow): *${blastQueue.failed.length}*\n` : ``) +
      `⏳ Remaining: *${pendingLeft}*\n` +
      (pendingLeft > 0 ? `📅 Est. *${daysLeft} more day${daysLeft > 1 ? "s" : ""}* to complete` : `🎉 All sent!`)
    );
  }
}

async function handleAdminReply(from, text, t, contextMsgId) {
  // APPROVE PAY 919XXXXXXXXX 5000
  // Also handle Y/YES/N/NO as quick response to last pending action

  // Check if admin replied to a specific payment notification message
  const repliedPayment = contextMsgId ? adminNotifMsgMap[contextMsgId] : null;

  if (["Y","YES"].includes(t)) {
    if (repliedPayment) {
      // Admin replied YES to a specific payment screenshot notification
      text = `APPROVE PAY ${repliedPayment.agentPhone} ${repliedPayment.amount}`;
      t = text.toUpperCase();
    } else if (lastPendingPaymentPhone && pendingPayments[lastPendingPaymentPhone]) {
      // Admin typed YES — approve most recent payment screenshot
      const p = pendingPayments[lastPendingPaymentPhone];
      text = `APPROVE PAY ${lastPendingPaymentPhone} ${p.amount}`;
      t = text.toUpperCase();
    } else if (Object.keys(pendingCancellations).length > 0) {
      // Auto approve latest cancellation
      const latestKey = Object.keys(pendingCancellations).pop();
      text = `APPROVE CANCEL ${latestKey}`;
      t = text.toUpperCase();
    }
  }
  if (["N","NO"].includes(t)) {
    if (repliedPayment) {
      text = `REJECT PAY ${repliedPayment.agentPhone}`;
      t = text.toUpperCase();
    } else if (lastPendingPaymentPhone && pendingPayments[lastPendingPaymentPhone]) {
      text = `REJECT PAY ${lastPendingPaymentPhone}`;
      t = text.toUpperCase();
    } else if (Object.keys(pendingCancellations).length > 0) {
      const latestKey = Object.keys(pendingCancellations).pop();
      text = `REJECT CANCEL ${latestKey}`;
      t = text.toUpperCase();
    }
  }

  // Flexible: "APPROVE 919..." or "APPROVE PAY 919..."
  if (t.startsWith("APPROVE PAY") || (t.startsWith("APPROVE ") && /91\d{10}/.test(t))) {
    const parts = text.trim().split(/\s+/);
    const agentPhone = parts[2];
    const amount = parseInt(parts[3]);
    const pending = pendingPayments[agentPhone];
    if (!pending) {
      await sendMessage(from, `No pending payment found for ${agentPhone}`);
      return;
    }

    const approvedAmount = amount || pending.amount;
    const paidSoFar = (pending.paidSoFar || 0) + approvedAmount;
    const remaining = pending.total - paidSoFar;
    const step = pending.paymentStep || 1;
    const UPI_ID = process.env.UPI_ID || "9816003322@okbizaxis";

    // Notify admin
    await sendMessage(from,
      `✅ Payment Step ${step} approved for ${pending.agentName} (${agentPhone})\n` +
      `Paid: Rs.${approvedAmount.toLocaleString()} | Total Paid: Rs.${paidSoFar.toLocaleString()}\n` +
      `Voucher: ${pending.voucherNo}\nRemaining: Rs.${remaining.toLocaleString()}`
    );

    // Build next payment message for agent
    let agentMsg =
      `✅ *PAYMENT CONFIRMED*\n\n` +
      `Voucher: *${pending.voucherNo}*\n` +
      `Amount Received: *Rs.${approvedAmount.toLocaleString()}*\n` +
      `Total Paid: Rs.${paidSoFar.toLocaleString()}\n` +
      `Total Booking: Rs.${pending.total.toLocaleString()}\n` +
      `Remaining: *Rs.${remaining.toLocaleString()}*\n\n`;

    if (remaining <= 0) {
      agentMsg += `🎉 All payments complete! Booking fully confirmed.\n`;
      agentMsg += `Check-in: ${fmtDate(pending.ciDate)}\nCheck-out: ${fmtDate(pending.coDate)}\n\nThank you! 🙏`;
      await sendReminder(agentPhone, agentMsg);

      // Send guest voucher (no price) to agent — for forwarding to guest
      try {
        const nights2 = Math.round((new Date(pending.coDate)-new Date(pending.ciDate))/86400000);
        const roomDisplay = pending.roomTypes && pending.roomTypes.length > 1
          ? pending.roomTypes.map(r => `${r.count} x ${r.type === "honeymoon" ? "Honeymoon" : r.type === "superdeluxe" ? "Super Deluxe" : "Deluxe"}`).join(" + ")
          : `${pending.rooms || 1} x ${pending.roomType || "Deluxe"}`;

        const guestVoucher =
          `🏨 *HOTEL SUKHSAGAR REGENCY*\n` +
          `Shimla, Himachal Pradesh\n` +
          `📞 +91 98160 03322\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `📋 *GUEST BOOKING VOUCHER*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Voucher No: *${pending.voucherNo}*\n` +
          `Date: *${fmtDate(new Date().toISOString().split("T")[0])}*\n\n` +
          `*GUEST DETAILS*\n` +
          `Name: *${pending.guestName}*\n\n` +
          `*BOOKING DETAILS*\n` +
          `Check-in:  *${fmtDate(pending.ciDate)}*\n` +
          `Check-out: *${fmtDate(pending.coDate)}*\n` +
          `Nights:    *${nights2}*\n` +
          `Rooms:     *${roomDisplay}*\n` +
          `Plan:      *${pending.plan || "CP"}*\n\n` +
          `*HOTEL POLICIES*\n` +
          `✅ Check-in time: 12:00 PM\n` +
          `✅ Check-out time: 11:00 AM\n` +
          `✅ Valid ID required at check-in\n` +
          `✅ Complementary: WiFi, Parking, Welcome drink\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `_This voucher is valid for the dates mentioned above._\n` +
          `_Please carry a valid photo ID at check-in._\n\n` +
          `📍 *How to reach us:*\n` +
          `Hotel Sukhsagar Regency\n` +
          `Tara Devi, Shimla - 171010\n` +
          `Google Maps: https://maps.google.com/?q=31.078199,77.140404`;

        await sendMessage(agentPhone, `📄 *Guest Voucher* (forward to your guest):\n\n` + guestVoucher);
        console.log("Guest voucher sent to", agentPhone);

        // Send location separately
        const axios = require("axios");
        await axios.post(
          `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: agentPhone,
            type: "location",
            location: {
              longitude: 77.140404,
              latitude: 31.078199,
              name: "Hotel Sukhsagar Regency",
              address: "Tara Devi, Shimla, Himachal Pradesh 171010"
            }
          },
          { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log("Location sent to", agentPhone);
      } catch(vErr) {
        console.error("Guest voucher send error:", vErr.message);
      }

      delete pendingPayments[agentPhone];
    } else {
      // Determine next payment details
      const schedule = pending.paymentSchedule || [];
      const nextStep = schedule[step]; // step is 0-indexed after first payment
      if (nextStep) {
        agentMsg += `📅 *Next Payment:*\n${nextStep.label}: Rs.${nextStep.amount.toLocaleString()} — ${nextStep.due}\n\n`;
        agentMsg += `Check-in: ${fmtDate(pending.ciDate)}\nThank you, ${pending.agentName}! 🙏`;
        await sendReminder(agentPhone, agentMsg);

        // Short notice bookings — just remind about balance, no extra QR
        if (pending.daysToCheckin < 15 && step === 1) {
          await sendReminder(agentPhone,
            `💡 *Remaining Balance: Rs.${nextStep.amount.toLocaleString()}*\n` +
            `Please pay at check-in.\nVoucher: ${pending.voucherNo}`
          );
        }
      } else {
        agentMsg += `Remaining Rs.${remaining.toLocaleString()} to be paid at check-in.\n\nThank you! 🙏`;
        await sendReminder(agentPhone, agentMsg);
      }

      // Update pending payment
      pendingPayments[agentPhone] = {
        ...pending,
        paidSoFar,
        amount: nextStep?.amount || remaining,
        remaining,
        paymentStep: step + 1,
      };
    }
    return;
  }

  // REJECT PAY 919XXXXXXXXX — also "REJECT 919..."
  if (t.startsWith("REJECT PAY") || (t.startsWith("REJECT ") && /91\d{10}/.test(t) && !t.startsWith("REJECT CANCEL"))) {
    const parts = text.trim().split(/\s+/);
    const agentPhone = parts[2];
    const pending = pendingPayments[agentPhone];
    if (!pending) {
      await sendMessage(from, `No pending payment found for ${agentPhone}`);
      return;
    }
    await sendMessage(from, `❌ Payment rejected for ${pending.agentName} (${agentPhone})`);
    await sendReminder(agentPhone,
      `❌ *PAYMENT NOT CONFIRMED*\n\n` +
      `Voucher: ${pending.voucherNo}\n` +
      `Your payment screenshot could not be verified.\n\n` +
      `Please resend the screenshot or contact hotel:\n📞 +91 98160 03322`
    );
    delete pendingPayments[agentPhone];
    return;
  }

  // PAY RECEIVED 919XXXXXXXXX 5000 — admin manually records payment
  if (t.startsWith("PAY RECEIVED") || t.startsWith("PAYMENT RECEIVED") || t.startsWith("PAY REC")) {
    const parts = text.trim().split(/\s+/);
    // Find phone number in parts
    const phoneIdx = parts.findIndex(p => /^91\d{10}$/.test(p.replace(/\D/g,'')));
    const agentPhone = phoneIdx >= 0 ? parts[phoneIdx].replace(/\D/g,'') : null;
    // Find amount in parts
    const amountIdx = parts.findIndex((p, i) => i > 0 && /^\d{3,6}$/.test(p));
    const amount = amountIdx >= 0 ? parseInt(parts[amountIdx]) : null;

    if (!agentPhone) {
      await sendMessage(from,
        `Format: *PAY RECEIVED 919XXXXXXXXX 5000*\n\n` +
        `Example: PAY RECEIVED 919816003322 5000`
      );
      return;
    }

    const pending = pendingPayments[agentPhone];
    if (!pending) {
      // No pending payment — just acknowledge
      await sendMessage(from,
        `✅ Payment recorded for ${agentPhone}${amount ? ` — Rs.${amount.toLocaleString()}` : ""}\n\n` +
        `No pending payment found in system. If this is a new advance, use APPROVE PAY command.`
      );
      return;
    }

    const approvedAmt = amount || pending.amount;
    const paidSoFar = (pending.paidSoFar || 0) + approvedAmt;
    const remaining = pending.total - paidSoFar;

    // Update pending payment
    pendingPayments[agentPhone] = { ...pending, paidSoFar, remaining };

    // Notify admin
    await sendMessage(from,
      `✅ Payment recorded:\n` +
      `Agent: ${pending.agentName} (${agentPhone})\n` +
      `Voucher: ${pending.voucherNo}\n` +
      `Amount received: Rs.${approvedAmt.toLocaleString()}\n` +
      `Total paid: Rs.${paidSoFar.toLocaleString()}\n` +
      `Remaining: Rs.${Math.max(0,remaining).toLocaleString()}`
    );

    // Notify agent
    await sendReminder(agentPhone,
      `✅ *PAYMENT RECEIVED*\n\n` +
      `Voucher: *${pending.voucherNo}*\n` +
      `Amount Received: *Rs.${approvedAmt.toLocaleString()}*\n` +
      `Total Paid: Rs.${paidSoFar.toLocaleString()}\n` +
      `Remaining: *Rs.${Math.max(0,remaining).toLocaleString()}*\n\n` +
      (remaining <= 0 ? `🎉 All payments complete! Booking fully confirmed.` : `💡 Remaining Rs.${remaining.toLocaleString()} due at check-in.`) +
      `\n\nThank you! 🙏`
    );

    if (remaining <= 0) delete pendingPayments[agentPhone];
    return;
  }

  // APPROVE CANCEL <voucherNo> — also "APPROVE SR-001" or "YES CANCEL SR-001"
  if (t.startsWith("APPROVE CANCEL") || t.startsWith("YES CANCEL") || t.startsWith("OK CANCEL")) {
    const parts = text.trim().split(/\s+/);
    const voucherNo = parts[parts.length - 1]; // Always last word
    const cancel = pendingCancellations[voucherNo];
    if (!cancel) {
      await sendMessage(from, `No pending cancellation found for ${voucherNo}`);
      return;
    }

    // Cancel in Stayezee
    if (cancel.stayezeeId) {
      try {
        await cancelReservation(cancel.stayezeeId);
        console.log(`Stayezee reservation ${cancel.stayezeeId} cancelled`);
      } catch(e) { console.error("Stayezee cancel error:", e.message); }
    }

    // Remove from pendingPayments
    delete pendingPayments[cancel.agentPhone];
    delete pendingCancellations[voucherNo];

    // Notify admin
    await sendMessage(from,
      `✅ Cancellation approved for ${voucherNo}\n` +
      `Agent: ${cancel.agentName} (${cancel.agentPhone})\n` +
      `Guest: ${cancel.guestName}\n` +
      `Refund: ${cancel.daysLeft > 15 ? `Rs.${cancel.refundAmount.toLocaleString()} (Full refund)` : "No refund"}`
    );

    // Notify agent
    await sendReminder(cancel.agentPhone,
      `✅ *BOOKING CANCELLED*\n\n` +
      `Voucher: *${voucherNo}*\n` +
      `Guest: ${cancel.guestName}\n` +
      `Check-in: ${fmtDate(cancel.ciDate)}\n\n` +
      `Your cancellation has been approved.\n` +
      (cancel.daysLeft > 15
        ? `💰 Refund of *Rs.${cancel.refundAmount.toLocaleString()}* will be processed shortly.`
        : `❌ No refund applicable (cancellation within 15 days of check-in).`) +
      `\n\nThank you for your business! 🙏`
    );
    return;
  }

  // REJECT CANCEL <voucherNo> — also "NO CANCEL SR-001"
  if (t.startsWith("REJECT CANCEL") || t.startsWith("NO CANCEL")) {
    const parts = text.trim().split(/\s+/);
    const voucherNo = parts[parts.length - 1];
    const cancel = pendingCancellations[voucherNo];
    if (!cancel) {
      await sendMessage(from, `No pending cancellation found for ${voucherNo}`);
      return;
    }

    delete pendingCancellations[voucherNo];

    await sendMessage(from, `❌ Cancellation rejected for ${voucherNo}`);
    await sendReminder(cancel.agentPhone,
      `❌ *CANCELLATION REJECTED*\n\n` +
      `Voucher: *${voucherNo}*\n` +
      `Guest: ${cancel.guestName}\n\n` +
      `Your cancellation request has been rejected.\n` +
      `Your booking is still active.\n\n` +
      `For assistance contact: 📞 +91 98160 03322`
    );
    return;
  }

  // LIST CANCEL — show all pending cancellations
  if (t === "LIST CANCEL") {
    const keys = Object.keys(pendingCancellations);
    if (!keys.length) { await sendMessage(from, "No pending cancellations."); return; }
    const lines = keys.map(k => {
      const c = pendingCancellations[k];
      return `• ${c.voucherNo} — ${c.guestName} — ${fmtDate(c.ciDate)} (${c.agentName})`;
    });
    await sendMessage(from, `📋 *Pending Cancellations (${keys.length}):*\n\n${lines.join("\n")}`);
    return;
  }

  // BLAST <message> — queue message to all agents, 50/day with auto-retry
  // BLAST STATUS — check current blast queue status
  // BLAST STOP — stop current blast campaign
  if (t.startsWith("BLAST")) {
    const subCmd = text.slice(5).trim();

    // BLAST STATUS
    if (subCmd.toUpperCase() === "STATUS") {
      if (!blastQueue.message) {
        await sendMessage(from, `📭 No active blast campaign.\n\nStart one with:\n*BLAST Your message here*`);
      } else {
        const total = blastQueue.pending.length + blastQueue.failed.length + blastQueue.sentCount;
        await sendMessage(from,
          `📊 *Blast Campaign Status*\n\n` +
          `📨 Sent today: *${blastQueue.todaySent}*\n` +
          `✅ Total sent: *${blastQueue.sentCount}*\n` +
          `⏳ Pending: *${blastQueue.pending.length}*\n` +
          `❌ Failed (retry tomorrow): *${blastQueue.failed.length}*\n` +
          `👥 Total: *${total}*\n\n` +
          `📝 Message:\n_${blastQueue.message}_\n\n` +
          `To stop: *BLAST STOP*`
        );
      }
      return;
    }

    // BLAST STOP
    if (subCmd.toUpperCase() === "STOP") {
      if (!blastQueue.message) {
        await sendMessage(from, `No active blast campaign to stop.`);
      } else {
        const stopped = blastQueue.pending.length;
        blastQueue.message = null;
        blastQueue.pending = [];
        blastQueue.failed = [];
        blastQueue.sentCount = 0;
        blastQueue.todaySent = 0;
        blastQueue.lastResetDate = null;
        await sendMessage(from, `🛑 *Blast stopped.*\n\n${stopped} remaining numbers cancelled.`);
      }
      return;
    }

    // BLAST <message> — start new campaign
    const blastMsg = subCmd;
    if (!blastMsg) {
      await sendMessage(from,
        `❌ Please include a message after BLAST.\n\n` +
        `Example:\n` +
        `*BLAST Hi everyone! Shimla season is here 🏔️ Book your rooms at Hotel Sukhsagar Regency now. Reply BOOK to get started!*\n\n` +
        `Other commands:\n` +
        `*BLAST STATUS* — check progress\n` +
        `*BLAST STOP* — stop campaign`
      );
      return;
    }

    if (blastQueue.message) {
      await sendMessage(from,
        `⚠️ A blast campaign is already running!\n\n` +
        `⏳ Pending: ${blastQueue.pending.length} numbers\n\n` +
        `Type *BLAST STOP* to stop it first, then start a new one.\n` +
        `Or *BLAST STATUS* to check progress.`
      );
      return;
    }

    const agents = await getAllAgents();
    if (agents.length === 0) {
      await sendMessage(from, `❌ No agents found in the list.`);
      return;
    }

    // Load queue with all agent phones
    blastQueue.message = blastMsg;
    blastQueue.pending = agents.map(a => a.phone);
    blastQueue.failed = [];
    blastQueue.sentCount = 0;
    blastQueue.todaySent = 0;
    blastQueue.lastResetDate = new Date().toISOString().split("T")[0];

    await sendMessage(from,
      `✅ *Blast Campaign Started!*\n\n` +
      `👥 Total agents: *${agents.length}*\n` +
      `📅 Rate: *50 messages/day*\n` +
      `⏱ Est. completion: *${Math.ceil(agents.length / 50)} days*\n\n` +
      `📝 Message:\n_${blastMsg}_\n\n` +
      `First 50 will be sent now. Check progress with *BLAST STATUS*`
    );

    // Trigger first batch immediately
    await runBlastBatch(from);
    return;
  }

  // LIST PAY — show all pending payments
  if (t === "LIST PAY") {
    const keys = Object.keys(pendingPayments);
    if (keys.length === 0) {
      await sendMessage(from, "No pending payments.");
      return;
    }
    const lines = keys.map(k => {
      const p = pendingPayments[k];
      return `• ${p.agentName} (${k})\nVoucher: ${p.voucherNo}\nAmount: Rs.${p.amount.toLocaleString()}`;
    });
    await sendMessage(from, `📋 *Pending Payments (${keys.length}):*\n\n${lines.join("\n\n")}`);
    return;
  }

  // BOOK command — smart parser handles any format admin types
  // BOOK 919876543210 Rahul Singh 22july 24july 2dlx CP 4500 REMARK honeymoon couple
  const isBook1 = t.startsWith("BOOK1 ");
  const isBook2 = t.startsWith("BOOK2 ");
  const isBook = t.startsWith("BOOK ") || isBook1 || isBook2;
  if (isBook) {
    if (isBook1 || isBook2) text = "BOOK " + text.slice(6);
    try {
      const rawText = text.trim();
      const parts = rawText.split(/\s+/);

      // Extract phone (always 2nd word)
      const guestPhone = parts[1].replace(/\D/g, "");
      const fullPhone = guestPhone.startsWith("91") ? guestPhone : "91" + guestPhone;

      // Extract everything after phone
      const afterPhone = parts.slice(2).join(" ");

      // ── Extract REMARK (everything after REMARK keyword) ──────
      const remarkMatch = afterPhone.match(/REMARK\s+(.+)$/i);
      const remark = remarkMatch ? remarkMatch[1].trim() : null;
      const textNoRemark = remarkMatch ? afterPhone.slice(0, remarkMatch.index).trim() : afterPhone;


      // ── Extract rate — LAST token if it's a plain number ──────
      // "BOOK1 919876543210 Rahul 22july 24july 2dlx CP 3000" → rate=3000
      let adminRate = null;

      // Method 1: explicit keyword @3000, Rs.3000, rate 3000
      const rateKwMatch = textNoRemark.match(/(?:@|rs\.?\s*|rate\s*|price\s*|tariff\s*)(\d{3,6})/i);
      if (rateKwMatch) {
        adminRate = parseInt(rateKwMatch[1]);
      }

      // Method 2: last word is a plain number (the rate)
      if (!adminRate) {
        const tokens = textNoRemark.trim().split(/\s+/);
        const lastToken = tokens[tokens.length - 1].replace(/[^0-9]/g, '');
        if (/^\d{3,5}$/.test(lastToken)) {
          const n = parseInt(lastToken);
          if (n >= 500 && n <= 50000) adminRate = n;
        }
      }

      // ── Extract plan ──────────────────────────────────────────
      let plan = "CP";
      const planMatch = textNoRemark.match(/(MAPAI|MAP|CPAI|CP|EP)/i);
      if (planMatch) plan = planMatch[1].toUpperCase();

      // ── Extract room type + count — supports multiple room types ──
      let roomType = "deluxe";
      let rooms = 1;
      let roomTypes = [];

      // Remove rate from text
      const textForRooms = adminRate
        ? textNoRemark.replace(String(adminRate), "").replace("@", "").trim()
        : textNoRemark;

      // Detect each room type with count — order matters (super before deluxe)
      const superRe = /(\d+)\s*(?:super\s*del(?:uxe)?|sdelx?|sdlx?|superdeluxe|spdlx)/gi;
      const honeyRe = /(\d+)\s*(?:honey(?:moon)?|hmoon|hm(?=\s|$|\d))/gi;
      const dlxRe   = /(\d+)\s*(?:del(?:uxe)?|dlx|delx)(?!\s*(?:super|sd))/gi;

      // Remove super matches first so deluxe doesn't pick them up
      let textForDlx = textForRooms.replace(/\d+\s*(?:super\s*del(?:uxe)?|sdelx?|sdlx?|superdeluxe|spdlx)/gi, '');

      let m;
      superRe.lastIndex = 0;
      while ((m = superRe.exec(textForRooms)) !== null)
        roomTypes.push({ type: "superdeluxe", count: parseInt(m[1]) });

      honeyRe.lastIndex = 0;
      while ((m = honeyRe.exec(textForRooms)) !== null)
        roomTypes.push({ type: "honeymoon", count: parseInt(m[1]) });

      dlxRe.lastIndex = 0;
      while ((m = dlxRe.exec(textForDlx)) !== null)
        roomTypes.push({ type: "deluxe", count: parseInt(m[1]) });

      // Also try "Xr" or "X rooms" as fallback
      if (roomTypes.length === 0) {
        const rRe = /(\d+)\s*r(?:ooms?)?\b/gi;
        while ((m = rRe.exec(textForRooms)) !== null)
          roomTypes.push({ type: "deluxe", count: parseInt(m[1]) });
      }

      if (roomTypes.length > 0) {
        roomType = roomTypes[0].type;
        rooms = roomTypes.reduce((s, r) => s + r.count, 0);
      } else {
        // Auto detect type
        if (/super|sdelx|sdlx/i.test(textForRooms)) roomType = "superdeluxe";
        else if (/honey|hmoon|\bhm\b/i.test(textForRooms)) roomType = "honeymoon";
        else roomType = "deluxe";
        // Auto rooms from guests
        const gm = textForRooms.match(/(\d+)\s*(?:guest|pax|person|adult|people)/i);
        rooms = gm ? Math.ceil(parseInt(gm[1]) / 3) : 1;
      }

      // ── Extract dates ─────────────────────────────────────────
      const { parseEnquiry } = require("./parser");
      // Pass all room types to parser if multiple, else single
      const roomInfoForParser = roomTypes.length > 1
        ? roomTypes.map(r => r.count + r.type).join(" ") + " " + plan
        : rooms + " " + roomType + " " + plan;
      const parsed = parseEnquiry(textNoRemark + " " + roomInfoForParser);

      if (!parsed || !parsed.ciDate || !parsed.coDate) {
        await sendMessage(from,
          `❌ Could not parse dates.\n\n` +
          `Format examples:\n` +
          `*BOOK 919XXXXXXXXX Rahul 22july 24july 2dlx CP 4500*\n` +
          `*BOOK 919XXXXXXXXX Rahul 22.07 24.07 2 super MAP*\n` +
          `*BOOK 919XXXXXXXXX Rahul 22july 24july 2honey CP REMARK anniversary*`
        );
        return;
      }

      // ── Extract guest name ────────────────────────────────────
      const dateRe = /\d{1,2}[\.\-\/]\d{1,2}|\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
      const dateMatch = textNoRemark.search(dateRe);
      let guestName = dateMatch > 0 ? textNoRemark.slice(0, dateMatch).trim() : "Guest";
      // Remove plan/room type keywords from name
      guestName = guestName.replace(/(CP|MAP|MAPAI|EP|deluxe|dlx|super|sdlx|honey|hm|\d+)/gi, '').trim() || "Guest";

      // ── Auto-add as Guest if not in list ──────────────────────
      const { getAgent, addAgent } = require("./agents");
      let agent = await getAgent(fullPhone);
      if (!agent) {
        await addAgent(fullPhone, guestName, "Guest");
        agent = { phone: fullPhone, name: guestName, category: "Guest" };
        await sendMessage(from, `📋 *${guestName}* (${fullPhone}) auto-added as Guest`);
      }

      // ── Get rate — admin puts TOTAL amount, not per night ────────
      const nights = Math.max(1, Math.round((new Date(parsed.coDate) - new Date(parsed.ciDate)) / 86400000));
      let grandTotal;
      let finalRate;
      let rateTypeLabel = "";

      if (adminRate) {
        // Admin put total amount directly — use as-is
        grandTotal = adminRate;
        finalRate = Math.round(adminRate / (rooms * nights)); // per night for display
        rateTypeLabel = "(admin total)";
      } else if (isBook1) {
        const { getCustomerRate } = require("./rates");
        const rateInfo = getCustomerRate(roomType, plan, parsed.ciDate);
        if (!rateInfo) {
          await sendMessage(from, `❌ Rate not found for ${roomType} ${plan}.\nAdd total: *BOOK1 ... 14400*`);
          return;
        }
        finalRate = rateInfo.rate;
        if (roomTypes.length > 1) {
          const { getCustomerRate: gcr } = require("./rates");
          grandTotal = 0;
          for (const rt of roomTypes) {
            const ri = gcr(rt.type, plan, parsed.ciDate);
            grandTotal += (ri?.rate || finalRate) * rt.count * nights;
          }
        } else {
          grandTotal = finalRate * rooms * nights;
        }
        rateTypeLabel = "(customer rate)";
      } else {
        const { getRate } = require("./rates");
        const rateInfo = getRate(roomType, plan, parsed.ciDate, agent.category === "Guest" ? "C" : agent.category);
        if (!rateInfo) {
          await sendMessage(from, `❌ Rate not found for ${roomType} ${plan}.\nAdd total: *BOOK ... 14400*`);
          return;
        }
        finalRate = rateInfo.rate;
        // For multiple room types, calculate each type separately
        if (roomTypes.length > 1) {
          grandTotal = 0;
          for (const rt of roomTypes) {
            const ri = getRate(rt.type, plan, parsed.ciDate, agent.category === "Guest" ? "C" : agent.category);
            grandTotal += (ri?.rate || finalRate) * rt.count * nights;
          }
        } else {
          grandTotal = finalRate * rooms * nights;
        }
        rateTypeLabel = "(agent rate)";
      }

      const advanceAmount = Math.round(grandTotal * 0.20);

      // Build room summary for multiple types
      const roomSummary = roomTypes.length > 1
        ? roomTypes.map(r => `${r.count} ${r.type === "superdeluxe" ? "Super Deluxe" : r.type === "honeymoon" ? "Honeymoon" : "Deluxe"}`).join(" + ")
        : `${rooms} x ${roomType === "superdeluxe" ? "Super Deluxe" : roomType === "honeymoon" ? "Honeymoon" : "Deluxe"}`;

      const fakeSession = {
        ciDate: parsed.ciDate,
        coDate: parsed.coDate,
        roomType,
        rooms,
        roomTypes: roomTypes.length > 1 ? roomTypes : null,
        plan: plan.toUpperCase(),
        rate: finalRate,
        grandTotal: Math.round(grandTotal), // pre-calculated total
        nights,
        adults: parsed.adults || rooms * 2,
        kids: 0,
        guestName,
        guestMobile: fullPhone,
        extraBed: 0,
        extraBedCharge: 0,
        extraBedType: null,
        remark,
      };

      const remarkText = remark ? `\nRemark: _${remark}_` : "";

      await sendMessage(from,
        `⏳ Creating booking for *${guestName}*...\n` +
        `${fmtDate(parsed.ciDate)} → ${fmtDate(parsed.coDate)}\n` +
        `${roomSummary} | ${plan}\n` +
        `Total: *Rs.${Math.round(grandTotal).toLocaleString()}*${adminRate ? " (admin set)" : ""}\n` +
        `Per night: Rs.${finalRate.toLocaleString()} ${rateTypeLabel}` +
        remarkText
      );

      // For BOOK1 (guest booking) — skip agent tally and free room logic
      if (isBook1) fakeSession.isGuestBooking = true;

      await confirmAndSave(fullPhone, agent, fakeSession);

      await sendMessage(from,
        `✅ *Booking created!*\n\n` +
        `Guest: ${guestName} (${fullPhone})\n` +
        `Check-in: ${fmtDate(parsed.ciDate)}\n` +
        `Check-out: ${fmtDate(parsed.coDate)}\n` +
        `Rooms: ${roomSummary}\n` +
        `Plan: ${plan}\n` +
        `Total: *Rs.${Math.round(grandTotal).toLocaleString()}*\n` +
        `Per night: Rs.${finalRate.toLocaleString()} ${rateTypeLabel}\n` +
        `Advance (20%): Rs.${advanceAmount.toLocaleString()}` +
        remarkText + `\n\n` +
        `Voucher + QR sent to ${fullPhone} ✅`
      );
    } catch(err) {
      console.error("Admin BOOK error:", err.message);
      await sendMessage(from, `❌ Booking failed: ${err.message}`);
    }
    return;
  }

  await sendMessage(from,
    `*Admin Commands:*\n\n` +
    `*Booking:*\n` +
    `BOOK 91XXXXXXXXXX Name 22july 24july 2dlx CP 4500\n` +
    `BOOK 91XXXXXXXXXX Name 22.07 24.07 2super MAP REMARK anniversary\n\n` +
    `*Payment:*\n` +
    `PAY RECEIVED 91XXXXXXXXXX 5000\n` +
    `APPROVE PAY 91XXXXXXXXXX 5000\n` +
    `REJECT PAY 91XXXXXXXXXX\n` +
    `LIST PAY\n` +
    `ADD AGENT 91XXXXXXXXXX Name A/B/C\n` +
    `REMOVE AGENT 91XXXXXXXXXX\n` +
    `LIST AGENTS\n` +
    `\n` +
    `*Broadcast:*\n` +
    `BLAST Your message here`
  );
}

async function safeHandleIncoming(args) {
  try {
    return await handleIncoming(args);
  } catch (err) {
    console.error("Unhandled bot error:", err);
    try {
      await sendMessage(args.from,
        `Sorry, I could not read this booking format properly.\n\n` +
        `Please send it like:\n` +
        `*31 May to 2 June, 4 adults, 2 kids age 1.5 and 4, CP*\n\n` +
        `Or share check-in, check-out, adults, kids and plan in separate lines.`
      );
      await sendReminder(ADMIN_PHONE,
        `BOT ERROR\nFrom: ${args.from}\nMessage: ${args.text || ""}\nError: ${err.message}`
      );
    } catch (notifyErr) {
      console.error("Error notification failed:", notifyErr);
    }
  }
}

module.exports = { handleIncoming: safeHandleIncoming, pendingOptIns, optedInGuests, pendingPayments, pendingCancellations, blastQueue, runBlastBatch };
