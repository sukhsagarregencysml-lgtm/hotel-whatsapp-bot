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

async function saveReservation({ guestName, guestMobile, male, female, kids, plan, tariff, rooms, checkinDate, checkoutDate, roomType, remarks, special_request }) {
  console.log('Saving reservation to Stayezee:', guestName, checkinDate, checkoutDate);
  try {
    const form = new FormData();
    form.append('guest_name', guestName || 'Guest');
    form.append('guest_mobile', guestMobile || '');
    form.append('male', String(male || 1));
    form.append('female', String(female || 0));
    form.append('kids', String(kids || 0));
    form.append('plan', plan || 'CP');
    form.append('tariff', String(tariff || 0));
    form.append('rooms', String(rooms || 1));
    form.append('checkin_date', checkinDate);
    form.append('checkout_date', checkoutDate);
    form.append('room_type', roomType || 'Deluxe');
    if (remarks || special_request) {
      form.append('remarks', remarks || special_request || '');
      form.append('special_request', remarks || special_request || '');
    }

    const res = await axios.post(
      'https://india.stayezeepms.co.in/FO/API/saveReservation',
      form,
      {
        headers: { 'X-Hotel-ID': HOTEL_ID, ...form.getHeaders() },
        timeout: 15000,
      }
    );

    console.log('Stayezee saveReservation response:', JSON.stringify(res.data));
    if (res.data?.status === false || res.data?.success === false) {
      return { success: false, data: res.data, error: res.data?.message || 'Stayezee rejected reservation' };
    }
    return { success: true, data: res.data };
  } catch (err) {
    console.error('Stayezee saveReservation error:', err.response?.data || err.message);
    return { success: false, data: err.response?.data, error: err.response?.data?.message || err.message };
  }
}

async function cancelReservation(reservationId) {
  try {
    const form = new FormData();
    form.append('reservation_id', String(reservationId));
    const res = await axios.post(
      'https://india.stayezeepms.co.in/FO/API/cancelReservation',
      form,
      { headers: { 'X-Hotel-ID': HOTEL_ID, ...form.getHeaders() }, timeout: 15000 }
    );
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { checkAvailability, saveReservation, cancelReservation };
