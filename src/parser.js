const MONTHS = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11
};

function parseEnquiry(text) {
  if (!text || text.trim().length < 5) return null;
  const lower = text.toLowerCase();
  const enquiryKeywords = ["room","availab","check","book","need","enquir","night","stay","ci","co","c/i","c/o","deluxe","honeymoon","super"];
  if (!enquiryKeywords.some(k => lower.includes(k))) return null;

  const result = {};

  // ── Rooms ──────────────────────────────────────────────────────────────
  const roomMatch = text.match(/(\d+)\s*(?:room|Room|ROOM)/i) || text.match(/room[s]?\s*[:\-]?\s*(\d+)/i);
  result.rooms = roomMatch ? parseInt(roomMatch[1]) : 1;

  // ── Plan ───────────────────────────────────────────────────────────────
  if (/\bCP\b/i.test(text)) result.plan = "CP";
  else if (/\bMAP\b/i.test(text)) result.plan = "MAP";
  else if (/\bEP\b/i.test(text)) result.plan = "EP";
  else result.plan = null;

  // ── Room type ──────────────────────────────────────────────────────────
  if (/honey/i.test(text)) result.roomType = "honeymoon";
  else if (/super\s*deluxe/i.test(text)) result.roomType = "superdeluxe";
  else if (/deluxe/i.test(text)) result.roomType = "deluxe";
  else result.roomType = null; // will ask later

  // ── Dates ──────────────────────────────────────────────────────────────
  const dates = extractDates(text);
  if (dates.length >= 2) { result.ciDate = toISO(dates[0]); result.coDate = toISO(dates[1]); }
  else if (dates.length === 1) { result.ciDate = toISO(dates[0]); result.coDate = null; }
  else return null;

  return result;
}

function extractDates(text) {
  const dates = [];
  const currentYear = new Date().getFullYear();
  const wordDateRe = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/gi;
  let m;
  while ((m = wordDateRe.exec(text)) !== null) {
    const day = parseInt(m[1]);
    const mon = MONTHS[m[2].toLowerCase().slice(0,3)];
    const yr = m[3] ? parseInt(m[3]) : currentYear;
    if (mon !== undefined && day >= 1 && day <= 31) dates.push({ day, month: mon, year: yr });
  }
  if (dates.length < 2) {
    const numDateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
    while ((m = numDateRe.exec(text)) !== null) {
      const day = parseInt(m[1]); const mon = parseInt(m[2]) - 1;
      const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : currentYear;
      if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
        if (!dates.find(d => d.day === day && d.month === mon)) dates.push({ day, month: mon, year: yr });
      }
    }
  }
  return dates.slice(0, 2);
}

function toISO({ day, month, year }) {
  return `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

module.exports = { parseEnquiry };
