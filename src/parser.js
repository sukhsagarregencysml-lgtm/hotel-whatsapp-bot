const MONTHS = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,
  nov:10,november:10,dec:11,december:11
};

function parseEnquiry(text) {
  if (!text || text.trim().length < 5) return null;
  const lower = text.toLowerCase();

  const enquiryKeywords = [
    "room","availab","check","book","need","enquir","night","stay",
    "ci","co","c/i","c/o","deluxe","honeymoon","super","dlx","sdlx",
    "honey","hm","sdx","sd","del","delx","mapai","cp","map","ep","best price",
    "booking","2n","3n","4n","5n","price","rate","tariff"
  ];
  if (!enquiryKeywords.some(k => lower.includes(k))) return null;

  const result = {};

  // -- Plan ---------------------------------------------------------------
  if (/\bMAPAI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\s*AI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\b/i.test(text)) result.plan = "MAP";
  else if (/\bCP\b/i.test(text)) result.plan = "CP";
  else if (/\bEP\b/i.test(text)) result.plan = "EP";
  else result.plan = null;

  // -- Room types ---------------------------------------------------------
  // Normalize room type string to standard type
  function toRoomType(s) {
    s = s.toLowerCase().replace(/\s+/g,'');
    if (/hon|honey|hone|hmoon|honeymoon/.test(s)) return 'honeymoon';
    if (/sup|super|sdlx|sdx|sd/.test(s)) return 'superdeluxe';
    if (/del|dlx|delu|delx|deluxe|dx/.test(s)) return 'deluxe';
    return null;
  }

  const roomTypes = [];

  // Pattern: "2 super deluxe", "2rooms super dlx", "2 sd", "2sdlx"
  // Handles: "Nrooms TYPE" and "N TYPE" and "N and TYPE"
  const patterns = [
    // "2 super deluxe" / "2 super dlx" / "2 sd" / "2sdlx"
    /(\d+)\s*(?:rooms?\s*)?(?:super\s*del(?:u(?:x(?:e)?)?)?|super\s*dlx|sdlx|sdx|s\.d\.?x?|super\b)/gi,
    // "2 honeymoon" / "2 honey" / "2 hon" / "2hm"
    /(\d+)\s*(?:rooms?\s*)?(?:hon(?:ey(?:moon)?)?|hm\b|hmoon)/gi,
    // "2 deluxe" / "2 dlx" / "2 delx" / "2del" - must come AFTER super deluxe
    /(\d+)\s*(?:rooms?\s*)?(?:del(?:u(?:x(?:e)?)?)?|dlx|delx|delu)\b(?!\s*(?:super))/gi,
  ];
  const typeNames = ['superdeluxe', 'honeymoon', 'deluxe'];

  // First check for "Nrooms TYPE" pattern like "2rooms super dlx"
  const roomsFirstPattern = /(\d+)\s*rooms?\s+(\w+(?:\s+\w+)?)/gi;
  let rm;
  while ((rm = roomsFirstPattern.exec(lower)) !== null) {
    const rt = toRoomType(rm[2]);
    if (rt) roomTypes.push({ type: rt, count: parseInt(rm[1]) });
  }

  if (roomTypes.length === 0) {
    for (let i = 0; i < patterns.length; i++) {
      let m;
      while ((m = patterns[i].exec(text)) !== null) {
        const rt = typeNames[i];
        if (!roomTypes.find(r => r.type === rt)) {
          roomTypes.push({ type: rt, count: parseInt(m[1]) });
        }
      }
    }
  }

  if (roomTypes.length > 0) {
    result.roomTypes = roomTypes;
    result.roomType = roomTypes[0].type;
    result.rooms = roomTypes.reduce((sum, r) => sum + r.count, 0);
  } else {
    // Fallback single room type
    if (/honey|hon\b|hm\b/i.test(text)) result.roomType = "honeymoon";
    else if (/super|sdlx|sdx\b/i.test(text)) result.roomType = "superdeluxe";
    else if (/del|dlx|delx/i.test(text)) result.roomType = "deluxe";
    else result.roomType = null;

    const roomMatch = text.match(/(\d+)\s*(?:rooms?)/i);
    result.rooms = roomMatch ? parseInt(roomMatch[1]) : 1;
  }

  // -- Dates --------------------------------------------------------------
  // Check for explicit checkout keyword: "checkout 2june", "co 2june", "check out 2 june"
  const coKeywordRe = /(?:check[\s-]?out|checkout|co\b|c\/o|departure|till|to|until|upto)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
  const ciKeywordRe = /(?:check[\s-]?in|checkin|ci\b|c\/i|arrival|from)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;

  const coKwMatch = text.match(coKeywordRe);
  const ciKwMatch = text.match(ciKeywordRe);

  // Extract all dates from text
  const dates = extractDates(text);

  // Check for nights: "2N", "2 nights", "2 night", "2nts"
  const nightsMatch = text.match(/(\d+)\s*(?:n\b|nts\b|night|nite)/i);
  const nights = nightsMatch ? parseInt(nightsMatch[1]) : null;

  if (ciKwMatch && coKwMatch) {
    // Both explicitly mentioned
    const yr = new Date().getFullYear();
    const ciDay = parseInt(ciKwMatch[1]);
    const ciMon = MONTHS[ciKwMatch[2].toLowerCase().slice(0,3)];
    const coDay = parseInt(coKwMatch[1]);
    const coMon = MONTHS[coKwMatch[2].toLowerCase().slice(0,3)];
    result.ciDate = toISO({ day: ciDay, month: ciMon, year: yr });
    result.coDate = toISO({ day: coDay, month: coMon, year: yr });
  } else if (dates.length >= 2) {
    // Sort dates - smaller = checkin
    const d1 = new Date(dates[0].year, dates[0].month, dates[0].day);
    const d2 = new Date(dates[1].year, dates[1].month, dates[1].day);
    if (d1 <= d2) {
      result.ciDate = toISO(dates[0]);
      result.coDate = toISO(dates[1]);
    } else {
      result.ciDate = toISO(dates[1]);
      result.coDate = toISO(dates[0]);
    }
  } else if (dates.length === 1) {
    result.ciDate = toISO(dates[0]);
    // Calculate checkout from nights
    if (nights) {
      const ciD = new Date(dates[0].year, dates[0].month, dates[0].day);
      ciD.setDate(ciD.getDate() + nights);
      result.coDate = toISO({ day: ciD.getDate(), month: ciD.getMonth(), year: ciD.getFullYear() });
    } else if (coKwMatch) {
      const yr = new Date().getFullYear();
      result.coDate = toISO({
        day: parseInt(coKwMatch[1]),
        month: MONTHS[coKwMatch[2].toLowerCase().slice(0,3)],
        year: yr
      });
    } else {
      result.coDate = null;
    }
  } else {
    return null;
  }

  return result;
}

function extractDates(text) {
  const dates = [];
  const currentYear = new Date().getFullYear();

  // Word dates: "6 jul", "10 may 2026", "6th july", "15th JUNE"
  const wordDateRe = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/gi;
  let m;
  while ((m = wordDateRe.exec(text)) !== null) {
    const day = parseInt(m[1]);
    const mon = MONTHS[m[2].toLowerCase().slice(0,3)];
    const yr = m[3] ? parseInt(m[3]) : currentYear;
    if (mon !== undefined && day >= 1 && day <= 31) {
      if (!dates.find(d => d.day === day && d.month === mon)) {
        dates.push({ day, month: mon, year: yr });
      }
    }
  }

  // Numeric dates: "6/7", "10-05-2026"
  if (dates.length < 2) {
    const numDateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
    while ((m = numDateRe.exec(text)) !== null) {
      const day = parseInt(m[1]);
      const mon = parseInt(m[2]) - 1;
      const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : currentYear;
      if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
        if (!dates.find(d => d.day === day && d.month === mon)) {
          dates.push({ day, month: mon, year: yr });
        }
      }
    }
  }

  return dates.slice(0, 2);
}

function toISO({ day, month, year }) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

module.exports = { parseEnquiry };
