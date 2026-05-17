"use strict";
const { parseEnquiry } = require("./parser");
const { checkAvailability } = require("./stayezee");
const { getRate, getCustomerRate, CUSTOMER_EXTRAS } = require("./rates");
const { saveReservation } = require("./stayezee");
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

async function handleIncoming({ from, text, msgId, msgType, mediaId }) {
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
    if (["SUPER","SUPERDELUXE","SDL","SDX"].includes(t)) {
      session.roomType = "superdeluxe";
      session.roomTypes = [{ type: "superdeluxe", count: session.rooms }];
      await sendMessage(from, `Dear *${agent.name}*, checking Super Deluxe availability...`);
      await checkAndRespond(from, agent, session);
      return;
    }
    if (["HONEY","HONEYMOON","HM"].includes(t)) {
      session.roomType = "honeymoon";
      session.roomTypes = [{ type: "honeymoon", count: session.rooms }];
      await sendMessage(from, `Dear *${agent.name}*, checking Honeymoon availability...`);
      await checkAndRespond(from, agent, session);
      return;
    }
    if (["DELUXE","DLX","DEL"].includes(t)) {
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

      rateMsg += `Check-in: *${fmtDate(session.ciDate)}*\n`;
      rateMsg += `Check-out: *${fmtDate(session.coDate)}*\n`;
      rateMsg += `Nights: *${nights}*\nPlan: *${plan}*\n`;
      rateMsg += `Total (without extra bed): *Rs.${grandTotal.toLocaleString()}*\n\n`;
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

      // Set 5 minute timeout - release if no reply
      if (session.timeoutId) clearTimeout(session.timeoutId);
      session.timeoutId = setTimeout(async () => {
        if (sessions[from]?.step === "awaiting_confirm") {
          sessions[from].step = "idle";
          sessions[from].timeoutId = null;
          try {
            await sendMessage(from,
              `Dear *${agent.name}*,\n\nYour booking hold has been *released* due to no response.\n\n` +
              `Rooms are now available for other bookings.\n\n` +
              `Please send a new enquiry if you still need rooms. 🙏`
            );
          } catch(e) { console.error("Timeout message error:", e.message); }
        }
      }, 5 * 60 * 1000); // 5 minutes

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

    const nights = session.nights || 1;
    const rooms = session.rooms || 1;
    const rate = session.rate || 0;
    const extraCharge = (session.extraBedCharge || 0) * nights;
    const roomTotal = rate * rooms * nights;
    const grandTotal = roomTotal + extraCharge;
    const typeName = pmsRoomType;

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
      `\n*AMOUNT*\n` +
      `Rate:  Rs.${Math.round(rate).toLocaleString()}/night\n`;

    if (extraCharge > 0) {
      voucherMsg += `Extra: Rs.${Math.round(extraCharge).toLocaleString()}\n`;
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
      `Rooms: ${rooms} x ${typeName}\n` +
      `Plan: ${session.plan}\n` +
      `Total: Rs.${Math.round(grandTotal).toLocaleString()}`;

    await sendReminder(ADMIN_PHONE, adminMsg);

    // Send UPI QR code for advance payment (20%)
    try {
      const advanceAmount = Math.round(grandTotal * 0.20);
      const remaining = grandTotal - advanceAmount;
      pendingPayments[from] = {
        agentName: agent.name,
        agentPhone: from,
        amount: advanceAmount,
        total: Math.round(grandTotal),
        remaining: Math.round(remaining),
        voucherNo,
        ciDate: session.ciDate,
        coDate: session.coDate,
        guestName: session.guestName,
      };

      const UPI_ID = process.env.UPI_ID || "9816003322@okbizaxis";
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=upi://pay?pa=${UPI_ID}%26pn=Hotel%20Sukhsagar%20Regency%26am=${advanceAmount}%26cu=INR%26tn=Advance-${voucherNo}`;

      const axios = require("axios");
      // Send QR image
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
              `💳 *ADVANCE PAYMENT REQUEST*\n\n` +
              `Voucher: *${voucherNo}*\n` +
              `Total Amount: *Rs.${Math.round(grandTotal).toLocaleString()}*\n` +
              `Advance (20%): *Rs.${advanceAmount.toLocaleString()}*\n` +
              `Remaining: Rs.${Math.round(remaining).toLocaleString()}\n\n` +
              `UPI ID: *${UPI_ID}*\n\n` +
              `📸 Please pay Rs.${advanceAmount.toLocaleString()} and send the *payment screenshot* here to confirm your booking.`
          }
        },
        { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log("UPI QR sent to agent", from);

      // For guests — also send plain text UPI details via template as fallback
      if (agent.category === "Guest") {
        try {
          // Send UPI details as a second hotel_confirmed template with payment info
          await sendReminder(from,
            `💳 *ADVANCE PAYMENT*\n\n` +
            `Amount: *Rs.${advanceAmount.toLocaleString()}* (20% advance)\n` +
            `UPI ID: *${UPI_ID}*\n` +
            `Voucher: ${voucherNo}\n\n` +
            `Please pay and send screenshot to confirm booking.`
          );
        } catch(e) { console.error("Guest payment text error:", e.message); }
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
      const { checkAvailability } = require("./stayezee");
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
    const remaining = pending.total - (amount || pending.amount);
    // Notify admin
    await sendMessage(from,
      `✅ Payment of Rs.${(amount || pending.amount).toLocaleString()} approved for ${pending.agentName} (${agentPhone})\n` +
      `Voucher: ${pending.voucherNo}\nRemaining: Rs.${remaining.toLocaleString()}`
    );
    // Notify agent
    await sendReminder(agentPhone,
      `✅ *PAYMENT CONFIRMED*\n\n` +
      `Voucher: *${pending.voucherNo}*\n` +
      `Amount Received: *Rs.${(amount || pending.amount).toLocaleString()}*\n` +
      `Total Booking: Rs.${pending.total.toLocaleString()}\n` +
      `Remaining Balance: *Rs.${remaining.toLocaleString()}*\n\n` +
      `Your booking is fully confirmed! 🎉\n` +
      `Check-in: ${fmtDate(pending.ciDate)}\n` +
      `Check-out: ${fmtDate(pending.coDate)}\n\n` +
      `Thank you, ${pending.agentName}! 🙏`
    );
    if (remaining > 0) {
      await sendReminder(agentPhone,
        `💡 Remaining balance of *Rs.${remaining.toLocaleString()}* to be paid at check-in.`
      );
    }
    delete pendingPayments[agentPhone];
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

  // BOOK 919876543210 Rahul Singh 22july 24july 2 deluxe CP
  if (t.startsWith("BOOK ")) {
    try {
      // Parse: BOOK <phone> <name...> <ciDate> <coDate> <rooms> <roomType> <plan>
      const parts = text.trim().split(/\s+/);
      // parts[0] = BOOK
      // parts[1] = phone
      // Last 3 parts = rooms, roomType, plan (optional)
      // Middle parts = name + dates

      const guestPhone = parts[1].replace(/\D/g, "");
      const fullPhone = guestPhone.startsWith("91") ? guestPhone : "91" + guestPhone;

      // Detect plan at end
      let plan = "CP";
      let lastIdx = parts.length - 1;
      if (/^(CP|MAP|MAPAI|EP)$/i.test(parts[lastIdx])) {
        plan = parts[lastIdx].toUpperCase();
        lastIdx--;
      }

      // Detect roomType
      let roomType = "deluxe";
      if (/^(deluxe|dlx|superdeluxe|sdlx|honeymoon|honey|hm)$/i.test(parts[lastIdx])) {
        const rt = parts[lastIdx].toLowerCase();
        if (rt.includes("super") || rt === "sdlx") roomType = "superdeluxe";
        else if (rt.includes("honey") || rt === "hm") roomType = "honeymoon";
        else roomType = "deluxe";
        lastIdx--;
      }

      // Detect rooms count
      let rooms = 1;
      if (/^\d+$/.test(parts[lastIdx]) && parseInt(parts[lastIdx]) <= 20) {
        rooms = parseInt(parts[lastIdx]);
        lastIdx--;
      }

      // Remaining middle parts after phone = name + dates
      // Try to extract 2 dates from remaining text
      const middleText = parts.slice(2, lastIdx + 1).join(" ");
      const { parseEnquiry } = require("./parser");
      const parsed = parseEnquiry(middleText + " " + rooms + " " + roomType + " " + plan);

      if (!parsed || !parsed.ciDate || !parsed.coDate) {
        await sendMessage(from,
          `❌ Could not parse dates. Format:

` +
          `*BOOK 919876543210 Rahul Singh 22july 24july 2 deluxe CP*`
        );
        return;
      }

      // Extract guest name (parts between phone and first date)
      // Find where dates start in middleText
      const dateRe = /\d{1,2}[\.\-\/]\d{1,2}|\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
      const dateMatch = middleText.search(dateRe);
      const guestName = dateMatch > 0 ? middleText.slice(0, dateMatch).trim() : "Guest";

      // Check if number exists in agents, if not auto-add as Guest category
      const { getAgent, addAgent } = require("./agents");
      let agent = await getAgent(fullPhone);
      if (!agent) {
        await addAgent(fullPhone, guestName, "Guest");
        agent = { phone: fullPhone, name: guestName, category: "Guest" };
        await sendMessage(from, `📋 *${guestName}* (${fullPhone}) auto-added as Guest`);
      }

      // Detect admin custom rate — last part if > 500
      let adminRate = null;
      const lastPart = parts[parts.length - 1];
      if (/^\d+$/.test(lastPart) && parseInt(lastPart) > 500 && parseInt(lastPart) !== rooms) {
        adminRate = parseInt(lastPart);
      }

      // Get rate — use admin rate if provided, else standard
      let finalRate;
      if (adminRate) {
        finalRate = adminRate;
      } else {
        const { getRate, getCustomerRate, CUSTOMER_EXTRAS } = require("./rates");
        const rateInfo = getRate(roomType, plan, parsed.ciDate, agent.category === "Guest" ? "C" : agent.category);
        if (!rateInfo) {
          await sendMessage(from, `❌ Could not find rate for ${roomType} ${plan}. Add rate at end:\n*BOOK ... 4500*`);
          return;
        }
        finalRate = rateInfo.rate;
      }

      const nights = Math.max(1, Math.round((new Date(parsed.coDate) - new Date(parsed.ciDate)) / 86400000));
      const grandTotal = finalRate * rooms * nights;
      const advanceAmount = Math.round(grandTotal * 0.20);

      // Build a fake session and call confirmAndSave
      const fakeSession = {
        ciDate: parsed.ciDate,
        coDate: parsed.coDate,
        roomType,
        rooms,
        plan: plan.toUpperCase(),
        rate: finalRate,
        nights,
        adults: parsed.adults || rooms * 2,
        kids: 0,
        guestName,
        guestMobile: fullPhone,
        extraBed: 0,
        extraBedCharge: 0,
        extraBedType: null,
      };

      await sendMessage(from,
        `⏳ Creating booking for *${guestName}*...\n` +
        `${fmtDate(parsed.ciDate)} → ${fmtDate(parsed.coDate)}\n` +
        `${rooms} x ${roomType} | ${plan}\n` +
        `Rate: Rs.${finalRate.toLocaleString()}/night${adminRate ? " (admin rate)" : ""}\n` +
        `Total: Rs.${Math.round(grandTotal).toLocaleString()}`
      );

      await confirmAndSave(fullPhone, agent, fakeSession);

      await sendMessage(from,
        `✅ *Booking created!*\n\n` +
        `Guest: ${guestName} (${fullPhone})\n` +
        `Check-in: ${fmtDate(parsed.ciDate)}\n` +
        `Check-out: ${fmtDate(parsed.coDate)}\n` +
        `Rooms: ${rooms} x ${roomType}\n` +
        `Plan: ${plan}\n` +
        `Rate: Rs.${finalRate.toLocaleString()}/night${adminRate ? " (admin rate)" : ""}\n` +
        `Total: Rs.${Math.round(grandTotal).toLocaleString()}\n` +
        `Advance (20%): Rs.${advanceAmount.toLocaleString()}\n\n` +
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
    `BOOK 91XXXXXXXXXX Name 22july 24july 2 deluxe CP\n` +
    `APPROVE PAY 91XXXXXXXXXX 5000\n` +
    `REJECT PAY 91XXXXXXXXXX\n` +
    `LIST PAY\n` +
    `ADD AGENT 91XXXXXXXXXX Name A/B/C\n` +
    `REMOVE AGENT 91XXXXXXXXXX\n` +
    `LIST AGENTS`
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
