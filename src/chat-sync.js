const axios = require("axios");

const PMS_URL = process.env.PMS_URL || "https://api.optisetup.in";
const HOTEL_ID = process.env.HOTEL_UUID || "951b12be-b43d-421f-934c-10be06defd02";
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID;

function cleanPhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

async function syncChatMessage(payload) {
  const phone = cleanPhone(payload.phone);
  if (!phone || !PMS_URL) return;

  // Sync to HotelEase PMS
  try {
    await axios.post(`${PMS_URL.replace(/\/$/, "")}/api/whatsapp/message`, {
      hotelId: HOTEL_ID,
      phone,
      guestName: payload.guestName || null,
      roomNumber: payload.roomNumber || null,
      direction: payload.direction === 'outbound' ? 'out' : 'in',
      message: payload.message || '',
      msgType: payload.messageType || 'text',
      waMsgId: payload.waMessageId || null
    });
  } catch (err) {
    console.log("PMS sync skipped:", err.response?.data?.error || err.message);
  }

  // Sync to WA CRM
  if (WA_PHONE_ID) {
    try {
      await axios.post(`${PMS_URL.replace(/\/$/, "")}/api/wa-crm/sync`, {
        wa_phone_id: WA_PHONE_ID,
        phone,
        guest_name: payload.guestName || null,
        direction: payload.direction === 'outbound' ? 'out' : 'in',
        message: payload.message || '',
        msg_type: payload.messageType || 'text',
        wa_msg_id: payload.waMessageId || null
      });
    } catch (err) {
      console.log("WA CRM sync skipped:", err.response?.data?.error || err.message);
    }
  }
}

module.exports = { syncChatMessage, cleanPhone };
