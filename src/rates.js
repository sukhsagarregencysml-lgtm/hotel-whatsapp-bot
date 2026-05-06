// ── Season definitions ─────────────────────────────────────────────────────
const PEAK_SEASONS = [
  { start: "2026-04-15", end: "2026-06-30" },
  { start: "2026-12-21", end: "2027-01-01" }, // Christmas/New Year peak
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

// ── Base rates (net after tax) ─────────────────────────────────────────────
// Format: RATES[roomType][plan][season]
const BASE_RATES = {
  deluxe: {
    CP:  { peak: 4100, off: 3000 },
    MAP: { peak: 4900, off: 3600 },
  },
  superdeluxe: {
    CP:  { peak: 4600, off: 3500 },
    MAP: { peak: 5400, off: 4100 },
  },
  honeymoon: {
    CP:  { peak: 5100, off: 4000 },
    MAP: { peak: 5900, off: 4600 },
  },
};

// ── Category discounts (% discount from base rate) ────────────────────────
// A = best agents (highest discount)
// B = standard agents
// C = regular agents (no discount)
const CATEGORY_DISCOUNT = {
  A: parseFloat(process.env.DISCOUNT_A || "10"), // 10% off
  B: parseFloat(process.env.DISCOUNT_B || "5"),  // 5% off
  C: parseFloat(process.env.DISCOUNT_C || "0"),  // no discount
};

// ── Get rate for agent ─────────────────────────────────────────────────────
function getRate(roomType, plan, ciDate, category = "C") {
  const season = getSeason(ciDate);
  const roomKey = roomType.toLowerCase().replace(/\s/g, "").replace("-", "");
  const planKey = plan.toUpperCase();

  // Find matching room type
  let baseRate = null;
  if (roomKey.includes("honey")) baseRate = BASE_RATES.honeymoon?.[planKey]?.[season];
  else if (roomKey.includes("super")) baseRate = BASE_RATES.superdeluxe?.[planKey]?.[season];
  else baseRate = BASE_RATES.deluxe?.[planKey]?.[season];

  if (!baseRate) return null;

  // Apply category discount
  const discount = CATEGORY_DISCOUNT[category] || 0;
  const finalRate = Math.round(baseRate * (1 - discount / 100));

  return {
    rate: finalRate,
    season,
    baseRate,
    discount,
    roomType: roomKey.includes("honey") ? "Honeymoon" : roomKey.includes("super") ? "Super Deluxe" : "Deluxe",
  };
}

// ── Parse room type from agent message ────────────────────────────────────
function parseRoomType(text) {
  const lower = text.toLowerCase();
  if (lower.includes("honey")) return "honeymoon";
  if (lower.includes("super") || lower.includes("super deluxe")) return "superdeluxe";
  if (lower.includes("deluxe")) return "deluxe";
  return "deluxe"; // default
}

module.exports = { getRate, getSeason, parseRoomType };
