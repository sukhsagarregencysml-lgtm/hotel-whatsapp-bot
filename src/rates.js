// Season definitions
const PEAK_SEASONS = [
  { start: "2026-04-15", end: "2026-06-30" },
  { start: "2026-12-21", end: "2027-01-01" },
];

function getSeason(dateStr) {
  const date = new Date(dateStr);
  for (const season of PEAK_SEASONS) {
    if (date >= new Date(season.start) && date <= new Date(season.end)) {
      return "peak";
    }
  }
  return "off";
}

// GST rates as per Indian hotel GST rules
// Room tariff < 7500 = 12% GST
// Room tariff >= 7500 = 18% GST
function getGST(rate) {
  return rate >= 7500 ? 0.18 : 0.12;
}

// Base rates (GST inclusive)
const BASE_RATES = {
  deluxe: {
    CP:  { peak: 4100, off: 3000 },
    MAP: { peak: 4900, off: 3600 },
    EP:  { peak: 3500, off: 2500 },
  },
  superdeluxe: {
    CP:  { peak: 4600, off: 3500 },
    MAP: { peak: 5400, off: 4100 },
    EP:  { peak: 4000, off: 3000 },
  },
  honeymoon: {
    CP:  { peak: 5100, off: 4000 },
    MAP: { peak: 5900, off: 4600 },
    EP:  { peak: 4500, off: 3500 },
  },
};

const CATEGORY_DISCOUNT = {
  A: parseFloat(process.env.DISCOUNT_A || "10"),
  B: parseFloat(process.env.DISCOUNT_B || "5"),
  C: parseFloat(process.env.DISCOUNT_C || "0"),
};

function getRate(roomType, plan, ciDate, category = "C") {
  const season = getSeason(ciDate);
  const roomKey = roomType.toLowerCase().replace(/\s/g, "").replace("-", "");

  // Normalize plan - MAPAI = MAP + GST included
  const isMapai = plan.toUpperCase() === 'MAPAI';
  const planKey = isMapai ? 'MAP' : plan.toUpperCase();

  let baseRate = null;
  if (roomKey.includes("honey")) baseRate = BASE_RATES.honeymoon?.[planKey]?.[season];
  else if (roomKey.includes("super")) baseRate = BASE_RATES.superdeluxe?.[planKey]?.[season];
  else baseRate = BASE_RATES.deluxe?.[planKey]?.[season];

  if (!baseRate) return null;

  const discount = CATEGORY_DISCOUNT[category] || 0;
  const discountedRate = Math.round(baseRate * (1 - discount / 100));

  // Rates are already GST inclusive — no extra GST added
  let finalRate = discountedRate;
  let gstAmount = 0;

  return {
    rate: finalRate,
    baseRate: discountedRate,
    gstAmount,
    isMapai,
    season,
    discount,
    roomType: roomKey.includes("honey") ? "Honeymoon" : roomKey.includes("super") ? "Super Deluxe" : "Deluxe",
  };
}

function parseRoomType(text) {
  const lower = text.toLowerCase();
  if (lower.includes("honey")) return "honeymoon";
  if (lower.includes("super") || lower.includes("super deluxe")) return "superdeluxe";
  if (lower.includes("deluxe")) return "deluxe";
  return "deluxe";
}

module.exports = { getRate, getSeason, parseRoomType, getGST };
