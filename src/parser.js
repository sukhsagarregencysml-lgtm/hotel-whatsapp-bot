const MONTHS = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11
};

// Fuzzy room type normalizer
function normalizeRoomType(str) {
  const s = str.toLowerCase().replace(/\s+/g, '');
  if (/^hon(ey(moon)?)?$|^hm$|^hmoon$/.test(s)) return 'honeymoon';
  if (/^s(uper)?(d(el?(u?x(e)?)?)?|dlx|dx)?$|^sdlx$|^sdx$/.test(s)) return 'superdeluxe';
  if (/^d(el?(u?x(e)?)?|lx|x)?$/.test(s)) return 'deluxe';
  if (/^kbn$/.test(s)) return 'deluxe';
  if (/^f(am(ily)?|m)$/.test(s)) return 'honeymoon';
  return null;
}

function parseEnquiry(text) {
  if (!text || text.trim().length < 5) return null;
  const lower = text.toLowerCase();

  const enquiryKeywords = [
    "room","availab","check","book","need","enquir","night","stay",
    "ci","co","c/i","c/o","deluxe","honeymoon","super","dlx","sdlx",
    "honey","hm","sdx","sd","del","mapai","cp","map","ep"
  ];
  if (!enquiryKeywords.some(k => lower.includes(k))) return null;

  const result = {};

  // -- Plan (CP, MAP, MAPAI, EP) ------------------------------------------
  if (/\bMAPAI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\s*AI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\b/i.test(text)) result.plan = "MAP";
  else if (/\bCP\b/i.test(text)) result.plan = "CP";
  else if (/\bEP\b/i.test(text)) result.plan = "EP";
  else result.plan = null;

  // -- Multiple room types ------------------------------------------------
  const roomTypes = [];

  const sdPatterns = /(\d+)\s*(?:super\s*del(?:u(?:x(?:e)?)?)?|s\.?d\.?(?:lx)?|sdx|superd(?:el)?|s\s*deluxe)/gi;
  const honeyPatterns = /(\d+)\s*(?:hon(?:ey(?:moon)?)?|hm\b|hmoon|honey)/gi;
  const deluxePatterns = /(\d+)\s*(?:del(?:u(?:x(?:e)?)?)?|dlx\b|dx\b)(?!\s*(?:super|sd))/gi;

  let m;
  while ((m = sdPatterns.exec(text)) !== null) {
    roomTypes.push({ type: 'superdeluxe', count: parseInt(m[1]) });
  }
  while ((m = honeyPatterns.exec(text)) !== null) {
    roomTypes.push({ type: 'honeymoon', count: parseInt(m[1]) });
  }
  while ((m = deluxePatterns.exec(text)) !== null) {
    roomTypes.push({ type: 'deluxe', count: parseInt(m[1]) });
  }

  if (roomTypes.length > 0) {
    result.roomTypes = roomTypes;
    result.roomType = roomTypes[0].type;
    result.rooms = roomTypes.reduce((sum, r) => sum + r.count, 0);
  } else {
    // Single room type - fuzzy match each word
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      const rt = normalizeRoomType(word);
      if (rt) { result.roomType = rt; break; }
    }
    if (!result.roomType) {
      if (/honey/i.test(text)) result.roomType = "honeymoon";
      else if (/super/i.test(text)) result.roomType = "superdeluxe";
      else if (/del|dlx/i.test(text)) result.roomType = "deluxe";
      else result.roomType = null;
    }

    const roomMatch = text.match(/(\d+)\s*(?:room|Room|ROOM)/i) ||
                      text.match(/room[s]?\s*[:\-]?\s*(\d+)/i);
    result.rooms = roomMatch ? parseInt(roomMatch[1]) : 1;
  }

  // -- Dates --------------------------------------------------------------
  const dates = extractDates(text);
  if (dates.length >= 2) {
    // Always sort: smaller date = check-in, larger date = check-out
    const d1 = new Date(dates[0].year, dates[0].month, dates[0].day);
    const d2 = new Date(dates[1].year, dates[1].month, dates[1].day);
    if (d1 <= d2) {
      result.ciDate = toISO(dates[0]);
      result.coDate = toISO(dates[1]);
    } else {
      result.ciDate = toISO(dates[1]);
      result.coDate = toISO(dates[0]);
    }
  }
  else if (dates.length === 1) {
    result.ciDate = toISO(dates[0]);
    // Check if nights mentioned - e.g "10 may 2 nights"
    const nightsMatch = text.match(/(\d+)\s*(?:night|nite|nights)/i);
    if (nightsMatch) {
      const nights = parseInt(nightsMatch[1]);
      const ciD = new Date(dates[0].year, dates[0].month, dates[0].day);
      ciD.setDate(ciD.getDate() + nights);
      result.coDate = toISO({ day: ciD.getDate(), month: ciD.getMonth(), year: ciD.getFullYear() });
    } else {
      result.coDate = null;
    }
  }
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
      const yr = m[3] ? (m[3].length === 2 ? 2000+parseInt(m[3]) : parseInt(m[3])) : currentYear;
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
