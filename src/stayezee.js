const axios = require("axios");
const FormData = require("form-data");

const API_URL = "https://india.stayezeepms.co.in/FO/API/roomAvailability";
const HOTEL_ID = process.env.STAYEZEE_CUSTOMER_ID || "290323537";

// ── Always keep this many rooms reserved (not shown to agents) ─────────────
const BUFFER_ROOMS = parseInt(process.env.BUFFER_ROOMS || "4");

async function checkAvailability({ ciDate, coDate, rooms }) {
  console.log(`🔍 Checking Stayezee: ${ciDate} to ${coDate}, ${rooms} rooms requested`);
  try {
    const form = new FormData();
    form.append("checkin_date", ciDate);
    form.append("checkout_date", coDate);
    // ⚠️ Ask Stayezee for rooms + buffer so we keep 4 always reserved
    const roomsToCheck = parseInt(rooms) + BUFFER_ROOMS;
    form.append("rooms_required", String(roomsToCheck));

    const res = await axios.post(API_URL, form, {
      headers: { "X-Hotel-ID": HOTEL_ID, ...form.getHeaders() },
      timeout: 15000,
    });

    console.log("✓ Stayezee response:", JSON.stringify(res.data));
    const data = res.data;

    // If Stayezee says available — it means there are enough rooms
    // including our 4 buffer rooms
    if (data.status === true || data.message === "Rooms available") {
      return { available: true, availableRooms: parseInt(rooms) };
    }

    return { available: false, availableRooms: 0 };

  } catch (err) {
    console.error("✗ Stayezee error:", err.response?.data || err.message);
    return { available: null, error: err.message };
  }
}

module.exports = { checkAvailability };
