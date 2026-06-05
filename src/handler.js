"use strict";
const { parseEnquiry } = require("./parser");
const { handleGuestServices, registerGuestForServices, sendServiceMenu, startFeedback } = require("./guest-services");
const { getTally, updateTally, useFreeRooms } = require("./agents");
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

// Message dedup — prevent same message being processed twice
const processedMsgIds = new Set();

async function handleIncoming({ from, text, msgId, msgType, mediaId, buttonId }) {
  // Dedup check
  if (msgId && processedMsgIds.has(msgId)) {
    console.log("Duplicate message ignored:", msgId);
    return;
  }
  if (msgId) {
    processedMsgIds.add(msgId);
    setTimeout(() => processedMsgIds.delete(msgId), 60000); // clear after 1 min
  }

  // Normalize newlines — WhatsApp multiline messages
  text = (text || "").replace(/\r\n/g, " ").replace(/\n/g, " ").trim();
  const t = text.toUpperCase();
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
      await sendReminder(ADMIN_PHONE,
        `📸 *PAYMENT SCREENSHOT RECEIVED*\n\n` +
        `Agent: ${pending.agentName} (${from})\n` +
        `Voucher: ${pending.voucherNo}\n` +
        `Amount: Rs.${pending.amount.toLocaleString()}\n` +
        `Guest: ${pending.guestName}\n` +
        `Check-in: ${fmtDate(pending.ciDate)}\n\n` +
        `To approve: *APPROVE PAY ${from} ${pending.amount}*\n` +
        `To reject: *REJECT PAY ${from}*`
      );
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
    await handleAdminReply(from, text, t);
    return;
  }

  // -- CHECK IF REGISTERED AGENT ------------------------------------------
  const agent = await getAgent(from);
  if (!agent || agent.category === "Guest") {
    // Guests added by admin should not get agent booking flow
    // Handle payment screenshot from guests
    if (agent && agent.category === "Guest") {
      // Only handle payment screenshot — rest goes to guest flow
      if (sessions[from]?.step && sessions[from].step !== "idle") {
        // clear any accidental agent session
        sessions[from] = { step: "idle" };
      }
    }
    await handleGuest(from, text, t, buttonId);
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
  if (session.step === "awaiting_extra_bed") {
    if (t === "1") {
      session.extraBed = 1; session.extraBedCharge = getExtraPersonCharge(session.plan); session.extraBedType = "Extra person (above 10 yrs) with mattress";
    } else if (t === "2") {
      session.extraBed = 1; session.extraBedCharge = getChildNoBedCharge(session.plan); session.extraBedType = "Child no bed (6 to 10 yrs)";
    } else if (t === "3") {
      session.extraBed = 1; session.extraBedCharge = 0; session.extraBedType = "Child (under 5 yrs)";
    } else {
      session.extraBed = 0; session.extraBedCharge = 0; session.extraBedType = null;
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

      // Get cumulative tally for this agent (financial year)
      const tally = await getTally(from);
      const totalRoomsThisBooking = roomTypesList.reduce((s, r) => s + r.count, 0);
      const roomsAfterBooking = tally.roomsBooked + totalRoomsThisBooking;
      const freeRoomsAvailable = Math.floor(tally.roomsBooked / 10) - (tally.freeRoomsUsed || 0);
      const newFreeRoomsEarned = Math.floor(roomsAfterBooking / 10) - Math.floor(tally.roomsBooked / 10);

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
        rateMsg += `📊 FY Tally: ${tally.roomsBooked} rooms booked → ${roomsNeededForNext} more for next FREE room\n\n`;
      }

      if (newFreeRoomsEarned > 0) {
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
    }
  } catch (err) {
    console.error("checkAndRespond error:", err.message);
    await sendMessage(from, `Dear *${agent.name}*, sorry there was an error. Please try again.`);
  }
}

// Track in-progress bookings to prevent duplicates
const bookingInProgress = new Set();

async function confirmAndSave(from, agent, session) {
  // Prevent duplicate booking for same phone
  const bookingKey = `${from}_${session.ciDate}_${session.coDate}`;
  if (bookingInProgress.has(bookingKey)) {
    console.log("Duplicate booking prevented for:", bookingKey);
    return;
  }
  bookingInProgress.add(bookingKey);
  setTimeout(() => bookingInProgress.delete(bookingKey), 30000); // clear after 30s

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
      remarks: session.remark || "",   // Pass remark to Stayezee
      special_request: session.remark || "",
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
    // Store stayezee ID for potential cancellation
    session.stayezeeId = stayezeeData?.booking_id || stayezeeData?.id || stayezeeData?.reservation_no || null;

    const nights = session.nights || 1;
    const rooms = session.rooms || 1;
    const rate = session.rate || 0;
    const extraCharge = (session.extraBedCharge || 0) * nights;
    const roomTotal = rate * rooms * nights;
    const freeRoomDiscount = session.freeRoomDiscount || 0;
    const freeRoomsApplied = session.freeRoomsApplied || 0;
    const grandTotal = roomTotal + extraCharge - freeRoomDiscount;
    const typeName = pmsRoomType;

    // Generate voucher number
    const now = new Date();
    const voucherNo = "SR-" + String(now.getDate()).padStart(2,"0") +
                      String(now.getMonth()+1).padStart(2,"0") +
                      now.getFullYear() + "-" +
                      String(Math.floor(Math.random()*9000)+1000);
    const confirmNo = voucherNo; // Use our voucher number as confirmation

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
      `Rooms:     *${rooms} x ${typeName}*\n` +
      `Adults:    *${session.adults || 1}*\n` +
      `Kids:      *${session.kids || 0}${session.kidAges ? ` (${session.kidAges.join(", ")} yrs)` : ""}*\n` +
      `Plan:      *${session.plan}*\n`;

    if (session.extraBed) {
      voucherMsg += `Extra bed: *${session.extraBedType}*\n`;
    } else {
      voucherMsg += `Extra bed: None\n`;
    }

    voucherMsg +=
      `\n*AMOUNT*\n`;

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
      `━━━━━━━━━━━━━━━━━━━━━`;

    // Guests added by admin — use approved template (works for any number)
    // Agents — send full voucher text
    // For admin-initiated bookings, send voucher to admin + template to guest
    if (session.isGuestBooking) {
      // Send full voucher to ADMIN
      await sendReminder(ADMIN_PHONE, voucherMsg);

      // Send approved template to guest mobile number
      const guestMobile = session.guestMobile || from;
      try {
        const axios = require("axios");
        const ciForDisplay = fmtDate(session.ciDate);
        const coForDisplay = fmtDate(session.coDate);
        const totalRooms = String(session.rooms || 1);
        const planForDisplay = session.plan || "CP";
        const totalAmount = String(Math.round(grandTotal));

        await axios.post(
          `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: guestMobile,
            type: "template",
            template: {
              name: "hotel_confirmed",
              language: { code: "en" },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: ciForDisplay },
                  { type: "text", text: coForDisplay },
                  { type: "text", text: totalRooms },
                  { type: "text", text: planForDisplay },
                  { type: "text", text: totalAmount },
                  { type: "text", text: confirmNo }
                ]
              }]
            }
          },
          { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log(`✓ hotel_confirmed template sent to guest ${guestMobile}`);
      } catch(tplErr) {
        console.error("Template send to guest failed:", tplErr.response?.data || tplErr.message);
      }
    } else if (agent.category === "Guest") {
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
      form.append("to", session.isGuestBooking ? ADMIN_PHONE : from);
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
            to: session.isGuestBooking ? ADMIN_PHONE : from,
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
      `Rooms: ${rooms} x ${typeName}\n` +
      `Plan: ${session.plan}\n` +
      `Total: Rs.${Math.round(grandTotal).toLocaleString()}`;

    // Update financial year tally
    try {
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
      if (!session.isGuestBooking) {
        await sendReminder(from, tallyMsg);
      }
      // Update admin msg with tally
      const adminTallyNote = session.isGuestBooking ? "" : `\nFY Tally: ${tallyResult.newRooms} rooms | Free rooms used: ${session.freeRoomsApplied || 0}`;
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
        paymentSchedule,
        daysToCheckin,
        paidSoFar: 0,
        paymentStep: 1, // 1=first, 2=second, 3=final
        stayezeeId: session.stayezeeId || null, // for cancellation
      };

      // Send QR for first payment
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=upi://pay?pa=${UPI_ID}%26pn=Hotel%20Sukhsagar%20Regency%26am=${firstAmount}%26cu=INR%26tn=Advance-${voucherNo}`;
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
              `UPI ID: *${UPI_ID}*\n\n` +
              `📸 Scan QR or pay to UPI ID and send *payment screenshot* to confirm booking.`
          }
        },
        { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
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
              const reminderQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=upi://pay?pa=${UPI_ID}%26pn=Hotel%20Sukhsagar%20Regency%26am=${firstAmount}%26cu=INR%26tn=Advance-${voucherNo}`;
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

      // 2nd payment reminder is manual — admin sends when ready
      // Store the amount so admin can trigger with: SEND REMINDER 919XXXXXXXXX
      if (daysToCheckin >= 15) {
        const reminderDate = new Date(ciDate);
        reminderDate.setDate(reminderDate.getDate() - 15);
        if (pendingPayments[from]) {
          pendingPayments[from].secondPaymentAmount = Math.round(total * 0.35);
          pendingPayments[from].secondPaymentDueDate = reminderDate.toLocaleDateString("en-IN", {day:"numeric",month:"short",year:"numeric"});
        }
        // Notify admin about upcoming 2nd payment date
        await sendReminder(ADMIN_PHONE,
          `📅 *2ND PAYMENT INFO*\n` +
          `Agent: ${agent.name} (${from})\n` +
          `Voucher: ${voucherNo}\n` +
          `2nd Payment (35%): Rs.${Math.round(total * 0.35).toLocaleString()}\n` +
          `Due by: ${reminderDate.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}\n\n` +
          `To send reminder: *SEND REMINDER ${from}*`
        );
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
async function handleGuest(from, text, t, btnId = null) {
  // Check guest services FIRST (checked-in guests get button menus)
  const wa = require("./whatsapp");
  const handled = await handleGuestServices(from, text, btnId, wa);
  if (handled) return;

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

      const extraPerson = 500;
      const childNoBed = 300;
      await sendMessage(from,
        `✅ *Rooms Available!*\n\n` +
        `📅 Check-in:  *${fmtDate(session.ciDate)}*\n` +
        `📅 Check-out: *${fmtDate(session.coDate)}*\n` +
        `🌙 Nights:    *${nights}*\n` +
        `🛏 Room:      *${session.rooms} x ${pmsRoomType}*\n` +
        `🍽 Plan:      *${session.plan}*\n` +
        `💰 Rate:      *Rs.${rateInfo.rate.toLocaleString()}/night*\n` +
        `👤 Extra person: *Rs.${extraPerson}/night*\n` +
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
    await handleGuest(from, text, t, buttonId);
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

async function handleAdminReply(from, text, t) {
  // APPROVE PAY 919XXXXXXXXX 5000
  if (t.startsWith("APPROVE PAY")) {
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
      delete pendingPayments[agentPhone];
    } else {
      // Determine next payment details
      const schedule = pending.paymentSchedule || [];
      const nextStep = schedule[step]; // step is 0-indexed after first payment
      if (nextStep) {
        agentMsg += `📅 *Next Payment:*\n${nextStep.label}: Rs.${nextStep.amount.toLocaleString()} — ${nextStep.due}\n\n`;
        agentMsg += `Check-in: ${fmtDate(pending.ciDate)}\nThank you, ${pending.agentName}! 🙏`;
        await sendReminder(agentPhone, agentMsg);

        // Send QR for next payment if it's due soon (2nd payment for short-notice bookings)
        if (pending.daysToCheckin < 15 && step === 1) {
          // Short notice — send final QR immediately
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=upi://pay?pa=${UPI_ID}%26pn=Hotel%20Sukhsagar%20Regency%26am=${nextStep.amount}%26cu=INR%26tn=Final-${pending.voucherNo}`;
          const axios = require("axios");
          await axios.post(
            `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: agentPhone,
              type: "image",
              image: {
                link: qrUrl,
                caption:
                  `💳 *FINAL PAYMENT — At Check-in*\n\n` +
                  `Voucher: *${pending.voucherNo}*\n` +
                  `Amount: *Rs.${nextStep.amount.toLocaleString()}*\n` +
                  `UPI ID: *${UPI_ID}*\n\n` +
                  `Please pay at check-in.`
              }
            },
            { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
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

  // REJECT PAY 919XXXXXXXXX
  if (t.startsWith("REJECT PAY")) {
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

  // SEND REMINDER 919XXXXXXXXX — manually send 2nd payment QR
  if (t.startsWith("SEND REMINDER")) {
    const parts = text.trim().split(/\s+/);
    const agentPhone = parts[2]?.replace(/\D/g, "");
    const pending = agentPhone ? pendingPayments[agentPhone] : null;
    if (!pending) {
      await sendMessage(from, `No pending payment found for ${agentPhone || "that number"}\n\nUSE: *SEND REMINDER 919XXXXXXXXX*`);
      return;
    }
    const UPI_ID = process.env.UPI_ID || "9816003322@okbizaxis";
    const secondAmt = pending.secondPaymentAmount || Math.round(pending.total * 0.35);
    const upiLink = `upi://pay?pa=${UPI_ID}&pn=Hotel%20Sukhsagar%20Regency&am=${secondAmt}&cu=INR&tn=2nd-${pending.voucherNo}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&ecc=H&margin=2&data=${encodeURIComponent(upiLink)}`;
    const axios = require("axios");
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: agentPhone,
          type: "image",
          image: {
            link: qrUrl,
            caption:
              `⏰ *2ND PAYMENT REMINDER*\n\n` +
              `Voucher: *${pending.voucherNo}*\n` +
              `Guest: ${pending.guestName}\n` +
              `Check-in: *${fmtDate(pending.ciDate)}*\n\n` +
              `2nd Payment (35%): *Rs.${secondAmt.toLocaleString()}*\n` +
              `Total Booking: Rs.${pending.total.toLocaleString()}\n` +
              `UPI ID: *${UPI_ID}*\n\n` +
              `📸 Please pay and send screenshot.`
          }
        },
        { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      // Also send UPI text
      await sendReminder(agentPhone,
        `💡 *Payment Details:*\nUPI ID: *${UPI_ID}*\nAmount: *Rs.${secondAmt.toLocaleString()}*\nVoucher: ${pending.voucherNo}`
      );
      pendingPayments[agentPhone].paymentStep = 2;
      await sendMessage(from, `✅ 2nd payment reminder sent to ${agentPhone}\nAmount: Rs.${secondAmt.toLocaleString()}`);
    } catch(e) {
      await sendMessage(from, `❌ Failed to send reminder: ${e.message}`);
    }
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

  // BOOK/BOOK1/BOOK2 — smart parser with ADV, multiple rooms, remarks
  const isBook1 = t.startsWith("BOOK1 ");
  const isBook2 = t.startsWith("BOOK2 ");
  const isBook = t.startsWith("BOOK ") || isBook1 || isBook2;
  if (isBook) {
    if (isBook1 || isBook2) text = "BOOK " + text.slice(6);
    try {
      const rawParts = text.trim().split(/\s+/);
      const guestPhone = rawParts[1].replace(/\D/g, "");
      const fullPhone = guestPhone.startsWith("91") ? guestPhone : "91" + guestPhone;
      const afterPhone = rawParts.slice(2).join(" ");

      // Step 1: Normalize newlines + Extract REMARK
      // WhatsApp multiline: "Book1 ... 11000 adv 1000
Remarks 3 adults 1 kid"
      const normalizedAfterPhone = afterPhone.replace(/\n/g, " ").replace(/\r/g, " ");
      const remarkMatch = normalizedAfterPhone.match(/\bREMARK[S]?\b\s+(.+)$/i);
      const remark = remarkMatch ? remarkMatch[1].trim() : null;
      let clean = remarkMatch ? normalizedAfterPhone.slice(0, remarkMatch.index).trim() : normalizedAfterPhone;

      // Step 2: Extract ADV BEFORE rate (adv1000 or adv 1000)
      const advMatch = clean.match(/\bADV(?:ANCE)?\s*(\d+)\b/i) || clean.match(/\bPAID\s*(\d+)\b/i);
      const advancePaid = advMatch ? parseInt(advMatch[1]) : 0;
      if (advMatch) clean = clean.replace(advMatch[0], "").trim();

      // Step 3: Normalize dates — remove "to"/"from" between dates
      clean = clean.replace(/\bto\b/gi, " ").replace(/\bfrom\b/gi, " ").replace(/\s+/g, " ").trim();

      // Step 4: Extract rate (last number)
      let adminRate = null;
      const rateKwMatch = clean.match(/(?:@\s*|rs\.?\s*|rate\s*|price\s*)(\d{3,6})/i);
      if (rateKwMatch) { adminRate = parseInt(rateKwMatch[1]); }
      if (!adminRate) {
        const tokens = clean.trim().split(/\s+/);
        const last = tokens[tokens.length - 1].replace(/[^0-9]/g, "");
        if (/^\d{3,5}$/.test(last)) { const n = parseInt(last); if (n >= 500 && n <= 50000) adminRate = n; }
      }

      // Step 5: Extract plan
      let plan = "CP";
      const planM = clean.match(/\b(MAPAI|MAP|CPAI|CP|EP)\b/i);
      if (planM) plan = planM[1].toUpperCase();

      // Step 6: Extract room types
      const textForRooms = adminRate ? clean.replace(String(adminRate), "").replace(/@/g, "").trim() : clean;
      let textForDlx = textForRooms.replace(/\d+\s*(?:super\s*del(?:uxe)?|sdelx?|sdlx?|superdeluxe|spdlx)/gi, "");
      const superRe = /(\d+)\s*(?:super\s*del(?:uxe)?|sdelx?|sdlx?|superdeluxe|spdlx)/gi;
      const honeyRe = /(\d+)\s*(?:honey(?:moon)?|hmoon|hm(?=\s|$|\d))/gi;
      const dlxRe   = /(\d+)\s*(?:del(?:uxe)?|dlx|delx)(?!\s*(?:super|sd))/gi;
      let roomTypes = [], m;
      superRe.lastIndex = 0; while ((m = superRe.exec(textForRooms)) !== null) roomTypes.push({ type: "superdeluxe", count: parseInt(m[1]) });
      honeyRe.lastIndex = 0; while ((m = honeyRe.exec(textForRooms)) !== null) roomTypes.push({ type: "honeymoon", count: parseInt(m[1]) });
      dlxRe.lastIndex = 0;   while ((m = dlxRe.exec(textForDlx))   !== null) roomTypes.push({ type: "deluxe", count: parseInt(m[1]) });
      if (roomTypes.length === 0) { const rRe = /(\d+)\s*r(?:ooms?)?\b/gi; while ((m = rRe.exec(textForRooms)) !== null) roomTypes.push({ type: "deluxe", count: parseInt(m[1]) }); }
      let roomType = "deluxe", rooms = 1;
      if (roomTypes.length > 0) { roomType = roomTypes[0].type; rooms = roomTypes.reduce((s, r) => s + r.count, 0); }
      else {
        if (/super|sdelx|sdlx/i.test(textForRooms)) roomType = "superdeluxe";
        else if (/honey|\bhm\b/i.test(textForRooms)) roomType = "honeymoon";
        const gm = textForRooms.match(/(\d+)\s*(?:guest|pax|person|adult|people)/i);
        rooms = gm ? Math.ceil(parseInt(gm[1]) / 3) : 1;
      }

      // Step 7: Parse dates
      const { parseEnquiry } = require("./parser");
      const roomInfo = roomTypes.length > 1 ? roomTypes.map(r => r.count + r.type).join(" ") + " " + plan : rooms + " " + roomType + " " + plan;
      const parsed = parseEnquiry(clean + " " + roomInfo);
      if (!parsed?.ciDate || !parsed?.coDate) {
        await sendMessage(from, `❌ Could not parse dates.\nFormat: *BOOK1 919... Rahul 22july 24july 2dlx CP 14400 ADV 3000*`);
        return;
      }

      // Step 8: Guest name
      const dRe = /\d{1,2}[.\-\/]\d{1,2}|\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
      const dIdx = clean.search(dRe);
      let guestName = dIdx > 0 ? clean.slice(0, dIdx).trim() : "Guest";
      guestName = guestName.replace(/^name\s+/i, "").replace(/\b(CP|MAP|MAPAI|EP|deluxe|dlx|super|sdlx|honey|hm|\d+)\b/gi, "").replace(/\./g, "").trim() || "Guest";

      // Step 9: Auto-add agent/guest
      const { getAgent: ga, addAgent: aa } = require("./agents");
      let agent2 = await ga(fullPhone);
      if (!agent2) { await aa(fullPhone, guestName, "Guest"); agent2 = { phone: fullPhone, name: guestName, category: "Guest" }; await sendMessage(from, `📋 ${guestName} (${fullPhone}) added as Guest`); }

      // Step 10: Calculate rate
      const nights = Math.max(1, Math.round((new Date(parsed.coDate) - new Date(parsed.ciDate)) / 86400000));
      let grandTotal, finalRate, rateTypeLabel = "";
      if (adminRate) {
        grandTotal = adminRate; finalRate = Math.round(adminRate / (rooms * nights)); rateTypeLabel = "(admin total)";
      } else if (isBook1) {
        const { getCustomerRate } = require("./rates");
        const ri = getCustomerRate(roomType, plan, parsed.ciDate);
        if (!ri) { await sendMessage(from, `❌ Rate not found. Add total: *BOOK1 ... 14400*`); return; }
        finalRate = ri.rate; grandTotal = finalRate * rooms * nights; rateTypeLabel = "(customer rate)";
      } else {
        const { getRate } = require("./rates");
        const ri = getRate(roomType, plan, parsed.ciDate, agent2.category === "Guest" ? "C" : agent2.category);
        if (!ri) { await sendMessage(from, `❌ Rate not found. Add total: *BOOK ... 14400*`); return; }
        finalRate = ri.rate; grandTotal = finalRate * rooms * nights; rateTypeLabel = "(agent rate)";
      }

      const balanceAtCheckin = advancePaid > 0 ? Math.max(0, grandTotal - advancePaid) : null;
      const roomSummary = roomTypes.length > 1
        ? roomTypes.map(r => `${r.count} x ${r.type === "honeymoon" ? "Honeymoon" : r.type === "superdeluxe" ? "Super Deluxe" : "Deluxe"}`).join(" + ")
        : `${rooms} x ${roomType === "honeymoon" ? "Honeymoon" : roomType === "superdeluxe" ? "Super Deluxe" : "Deluxe"}`;
      const remarkText = remark ? `\nRemark: _${remark}_` : "";
      const advText = advancePaid > 0
        ? `\nAdvance Received: Rs.${advancePaid.toLocaleString()}\nBalance at Check-in: Rs.${balanceAtCheckin.toLocaleString()}`
        : `\nAdvance (20%): Rs.${Math.round(grandTotal * 0.20).toLocaleString()}`;

      const fakeSession = {
        ciDate: parsed.ciDate, coDate: parsed.coDate,
        roomType, rooms, roomTypes: roomTypes.length > 1 ? roomTypes : null,
        plan: plan.toUpperCase(), rate: finalRate, grandTotal: Math.round(grandTotal),
        nights, adults: parsed.adults || rooms * 2, kids: 0,
        guestName, guestMobile: fullPhone,
        extraBed: 0, extraBedCharge: 0, extraBedType: null,
        remark, isGuestBooking: isBook1, advancePaidByAdmin: advancePaid,
      };

      await sendMessage(from,
        `⏳ Creating for *${guestName}*...\n${fmtDate(parsed.ciDate)} → ${fmtDate(parsed.coDate)}\n` +
        `${roomSummary} | ${plan}\nTotal: *Rs.${Math.round(grandTotal).toLocaleString()}* ${rateTypeLabel}` + advText + remarkText
      );
      // Clear any existing session for guest phone to prevent duplicate bookings
      sessions[fullPhone] = { step: "idle" };

      await confirmAndSave(fullPhone, agent2, fakeSession);
      await sendMessage(from,
        `✅ *Booking created!*\n\nGuest: ${guestName} (${fullPhone})\n` +
        `Check-in: ${fmtDate(parsed.ciDate)}\nCheck-out: ${fmtDate(parsed.coDate)}\n` +
        `Rooms: ${roomSummary}\nPlan: ${plan}\nTotal: *Rs.${Math.round(grandTotal).toLocaleString()}*` +
        advText + remarkText +
        (advancePaid > 0 ? `\n\nNo QR sent — advance already received ✅` : `\n\nVoucher + QR sent ✅`)
      );
    } catch (err) { console.error("Admin BOOK error:", err.message); await sendMessage(from, `❌ Booking failed: ${err.message}`); }
    return;
  }

  await sendMessage(from,
    `*Admin Commands:*\n\n` +
    `*Booking:*\nBOOK1 919... Name 22july 24july 2dlx CP 14400 → Guest rates\n` +
    `BOOK2 919... Name 22july 24july 2dlx CP 14400 → Agent rates\n` +
    `Add ADV 3000 for advance already received\nAdd REMARK for notes\n\n` +
    `*Payment:*\nPAY RECEIVED 91XXXXXXXXXX 5000\nAPPROVE PAY 91XXXXXXXXXX 5000\n` +
    `REJECT PAY 91XXXXXXXXXX\nSEND REMINDER 91XXXXXXXXXX\nLIST PAY\n\n` +
    `*Cancellation:*\nAPPROVE CANCEL SR-001\nREJECT CANCEL SR-001\nLIST CANCEL\n\n` +
    `*Agents:*\nADD AGENT 91XXXXXXXXXX Name A/B/C\nREMOVE AGENT 91XXXXXXXXXX\nLIST AGENTS`
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

module.exports = { handleIncoming: safeHandleIncoming, pendingOptIns, optedInGuests, pendingPayments };
