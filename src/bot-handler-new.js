"use strict";
const { parseEnquiry } = require("./parser");
const { checkAvailability } = require("./stayezee");
const { getRate } = require("./rates");
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

async function getAgent(phone) {
  const db = require("./agents");
  return db.getAgent(phone);
}

async function handleIncoming({ from, text, msgId }) {
  const t = text.trim().toUpperCase();
  console.log(`MSG From ${from}: ${text}`);

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
  if (!agent) {
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

    await sendMessage(from, voucherMsg);

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

    // Send email to hotel
    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER || "info@sukhsagarregency.com",
          pass: process.env.EMAIL_PASS
        }
      });

      const emailHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1a1a2e;padding:20px;text-align:center">
            <h2 style="color:#C9A84C;margin:0">Hotel Sukhsagar Regency</h2>
            <p style="color:#fff;margin:5px 0;font-size:14px">Booking Voucher</p>
          </div>
          
          <div style="padding:20px;border:1px solid #eee">
            <table style="width:100%;margin-bottom:20px">
              <tr><td style="color:#666;padding:5px">Voucher No</td><td style="font-weight:bold;padding:5px">${voucherNo}</td></tr>
              <tr><td style="color:#666;padding:5px">Date</td><td style="padding:5px">${fmtDate(now.toISOString().split("T")[0])}</td></tr>
            </table>

            <h3 style="color:#C9A84C;border-bottom:1px solid #eee;padding-bottom:8px">Agent Details</h3>
            <table style="width:100%;margin-bottom:20px">
              <tr><td style="color:#666;padding:5px">Agent Name</td><td style="padding:5px">${agent.name}</td></tr>
              <tr><td style="color:#666;padding:5px">Agent Phone</td><td style="padding:5px">${from}</td></tr>
            </table>

            <h3 style="color:#C9A84C;border-bottom:1px solid #eee;padding-bottom:8px">Guest Details</h3>
            <table style="width:100%;margin-bottom:20px">
              <tr><td style="color:#666;padding:5px">Guest Name</td><td style="font-weight:bold;padding:5px">${session.guestName}</td></tr>
              <tr><td style="color:#666;padding:5px">Guest Mobile</td><td style="padding:5px">${session.guestMobile}</td></tr>
            </table>

            <h3 style="color:#C9A84C;border-bottom:1px solid #eee;padding-bottom:8px">Booking Details</h3>
            <table style="width:100%;margin-bottom:20px">
              <tr><td style="color:#666;padding:5px">Check-in</td><td style="font-weight:bold;padding:5px">${fmtDate(session.ciDate)}</td></tr>
              <tr><td style="color:#666;padding:5px">Check-out</td><td style="font-weight:bold;padding:5px">${fmtDate(session.coDate)}</td></tr>
              <tr><td style="color:#666;padding:5px">Nights</td><td style="padding:5px">${nights}</td></tr>
              <tr><td style="color:#666;padding:5px">Rooms</td><td style="padding:5px">${rooms} x ${typeName}</td></tr>
              <tr><td style="color:#666;padding:5px">Adults</td><td style="padding:5px">${session.adults || 1}</td></tr>
              <tr><td style="color:#666;padding:5px">Kids</td><td style="padding:5px">${session.kids || 0}${session.kidAges ? ` (${session.kidAges.join(", ")} yrs)` : ""}</td></tr>
              <tr><td style="color:#666;padding:5px">Plan</td><td style="padding:5px">${session.plan}</td></tr>
              <tr><td style="color:#666;padding:5px">Extra Bed</td><td style="padding:5px">${session.extraBed ? session.extraBedType : "None"}</td></tr>
            </table>

            <h3 style="color:#C9A84C;border-bottom:1px solid #eee;padding-bottom:8px">Amount</h3>
            <table style="width:100%;margin-bottom:20px">
              <tr><td style="color:#666;padding:5px">Rate per night</td><td style="padding:5px">Rs.${Math.round(rate).toLocaleString()}</td></tr>
              <tr><td style="color:#666;padding:5px">Room charges</td><td style="padding:5px">Rs.${Math.round(roomTotal).toLocaleString()}</td></tr>
              ${extraCharge > 0 ? `<tr><td style="color:#666;padding:5px">Extra bed charges</td><td style="padding:5px">Rs.${Math.round(extraCharge).toLocaleString()}</td></tr>` : ""}
              <tr style="background:#C9A84C"><td style="padding:8px;font-weight:bold;color:#fff">Total Amount</td><td style="padding:8px;font-weight:bold;color:#fff">Rs.${Math.round(grandTotal).toLocaleString()}</td></tr>
            </table>
          </div>

          <div style="background:#f5f5f5;padding:15px;text-align:center;font-size:12px;color:#666">
            Hotel Sukhsagar Regency, Shimla, Himachal Pradesh<br>
            📞 +91 98160 03322 | info@sukhsagarregency.com
          </div>
        </div>
      `;

      const mailOptions = {
        from: `"HotelEase Bot" <${process.env.EMAIL_USER}>`,
        to: "sukhsagarregencysml@gmail.com",
        subject: `New Booking - ${session.guestName} - ${fmtDate(session.ciDate)} - ${voucherNo}`,
        html: emailHtml
      };

      if (session._pdfPath) {
        mailOptions.attachments = [{
          filename: `Voucher-${voucherNo}.pdf`,
          path: session._pdfPath
        }];
      }

      await transporter.sendMail(mailOptions);

      console.log("Voucher email sent to hotel");
    } catch(emailErr) {
      console.error("Email error:", emailErr.message);
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

    // Send email to hotel
    try {
      const axios = require("axios");
      const PMS_URL = process.env.PMS_URL || "https://hotelease-pms.onrender.com";
      await axios.post(PMS_URL + "/api/reservations/send-booking-email", {
        to: "sukhsagarregencysml@gmail.com",
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
      console.log("Booking email sent to hotel");
    } catch(emailErr) {
      console.error("Email error:", emailErr.message);
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
      // Availability - tell them to call
      await sendMessage(from,
        `For room bookings, please contact us:\n\n` +
        `📞 *${HOTEL_INFO.phone}*\n` +
        `📍 ${HOTEL_INFO.location}\n\n` +
        `Or share your *Booking ID* if you have an existing booking.`
      );
      session.step = "start";
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
  await sendMessage(from, `Admin message received: ${text}`);
}

module.exports = { handleIncoming, pendingOptIns, optedInGuests };
