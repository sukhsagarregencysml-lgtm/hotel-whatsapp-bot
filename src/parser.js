const MONTHS = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,
  nov:10,november:10,dec:11,december:11
};

// Extract all dates including "22july" format (no space)
function extractDates(text) {
  const dates = [];
  const yr = new Date().getFullYear();

  // "22 24 july", "22 to 24 july", "22-24 july"
  const sharedMonthRe = /(\d{1,2})(?:st|nd|rd|th)?\s*(?:(?:to|till|until|upto|[-–])\s*|\s+)(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*(\d{4}))?/gi;
  let sharedM;
  while ((sharedM = sharedMonthRe.exec(text)) !== null) {
    const day1 = parseInt(sharedM[1]);
    const day2 = parseInt(sharedM[2]);
    const mon = MONTHS[sharedM[3].toLowerCase().slice(0,3)];
    const year = sharedM[4] ? parseInt(sharedM[4]) : yr;
    if (mon !== undefined && day1 >= 1 && day1 <= 31 && day2 >= 1 && day2 <= 31) {
      dates.push({ day: day1, month: mon, year });
      dates.push({ day: day2, month: mon, year });
    }
  }

  // "22july", "22nd july", "22 july 2026", "22july2026"
  const wordRe = /(\d{1,2})(?:st|nd|rd|th)?\s*[-\/.]?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*[-\/.]?\s*(\d{4}))?/gi;
  let m;
  while ((m = wordRe.exec(text)) !== null) {
    const day = parseInt(m[1]);
    const mon = MONTHS[m[2].toLowerCase().slice(0,3)];
    const year = m[3] ? parseInt(m[3]) : yr;
    if (mon !== undefined && day >= 1 && day <= 31) {
      if (!dates.find(d => d.day === day && d.month === mon))
        dates.push({ day, month: mon, year });
    }
  }

  // Numeric: "22/7", "22-07-2026", "22.07.2026"
  if (dates.length < 2) {
    const numRe = /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/g;
    while ((m = numRe.exec(text)) !== null) {
      const day = parseInt(m[1]), mon = parseInt(m[2]) - 1;
      const year = m[3] ? (m[3].length===2?2000+parseInt(m[3]):parseInt(m[3])) : yr;
      if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31)
        if (!dates.find(d => d.day===day && d.month===mon))
          dates.push({ day, month: mon, year });
    }
  }
  return dates.slice(0, 2);
}

function toISO({ day, month, year }) {
  return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function extractGuestCounts(text) {
  const guests = {};
  const adultsM = text.match(/(?:number\s+of\s+)?adults?\s*[:=-]?\s*(\d+)/i) || text.match(/(?:no\.?\s*of\s*)?paxs?\s*[:=-]?\s*(\d+)\s*adults?\b/i) || text.match(/(\d+)\s*adults?\b/i);
  if (adultsM) guests.adults = parseInt(adultsM[1]);

  const kidsCountM = text.match(/(?:kids?|children|child)\s*[:=-]?\s*(\d+)/i) || text.match(/(\d+)[^\S\r\n]*(?:kids?|children|child)\b/i);
  if (kidsCountM) guests.kids = parseInt(kidsCountM[1]);

  const kidsLineM = text.match(/(?:kids?|children|child)[^\n]*(?:ages?|yrs?|years?)[^\n]*/i);
  if (kidsLineM) {
    let agesText = kidsLineM[0].replace(/\b\d+[^\S\r\n]*(?:kids?|children|child)\b/gi, '');
    const ages = [];
    let ageM;
    const ageRe = /\d+(?:\.\d+)?/g;
    while ((ageM = ageRe.exec(agesText)) !== null) {
      ages.push(parseFloat(ageM[0]));
    }
    if (ages.length > 0) {
      guests.kidAges = ages;
      if (!guests.kids) guests.kids = ages.length;
    }
  }

  return guests;
}

function parseEnquiry(text) {
  if (!text || text.trim().length < 4) return null;
  const lower = text.toLowerCase();

  // Must have at least a date to be an enquiry
  const hasDate = /\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d[\/\-.]\d)/i.test(text);
  const hasBookingWord = /book|room|availab|enquir|need|check|night|\d+n\b|price|rate|del|dlx|honey|super|sd\b|cp\b|map\b|ep\b/i.test(text);
  if (!hasDate && !hasBookingWord) return null;

  const result = {};
  Object.assign(result, extractGuestCounts(text));

  // -- Plan ---------------------------------------------------------------
  if (/\bMAPAI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\b/i.test(text)) result.plan = "MAP";
  else if (/\bCPAI\b/i.test(text)) result.plan = "CP";
  else if (/\bCP\b/i.test(text)) result.plan = "CP";
  else if (/\bEP\b/i.test(text)) result.plan = "EP";
  else result.plan = null;

  // -- Room types ---------------------------------------------------------
  // Support: "2dlx", "2 dlx", "2del", "2 del", "1honey", "1hm", "2sdlx", "2sd"
  const roomTypes = [];

  // Super deluxe - must match before deluxe
  const sdRe = /(\d+)\s*(?:super\s*del(?:u(?:x(?:e)?)?)?|s\.?\s*d(?:lx|x)?\b|sdlx|sdx)/gi;
  // Honeymoon
  const honRe = /(\d+)\s*(?:hon(?:ey(?:moon)?)?|hm\b|hmoon)/gi;
  // Deluxe - won't match "super del"
  const dlxRe = /(\d+)\s*(?:del(?:u(?:x(?:e)?)?)?|dlx|delx)\b/gi;

  let m;
  while ((m = sdRe.exec(text)) !== null)
    roomTypes.push({ type: 'superdeluxe', count: parseInt(m[1]) });
  while ((m = honRe.exec(text)) !== null)
    roomTypes.push({ type: 'honeymoon', count: parseInt(m[1]) });

  // Remove super deluxe matches before running deluxe pattern
  const textNSD = text.replace(/\d+\s*(?:super\s*del(?:u(?:x(?:e)?)?)?|s\.?\s*d(?:lx|x)?\b|sdlx|sdx)/gi, '');
  while ((m = dlxRe.exec(textNSD)) !== null)
    roomTypes.push({ type: 'deluxe', count: parseInt(m[1]) });

  // Also handle "2rooms super dlx" pattern
  const roomsFirstRe = /(\d+)\s*rooms?\s+(\w+)/gi;
  if (roomTypes.length === 0) {
    while ((m = roomsFirstRe.exec(lower)) !== null) {
      const s = m[2];
      if (/sup|sd|sdlx/.test(s)) roomTypes.push({ type:'superdeluxe', count:parseInt(m[1]) });
      else if (/hon|hm/.test(s)) roomTypes.push({ type:'honeymoon', count:parseInt(m[1]) });
      else if (/del|dlx/.test(s)) roomTypes.push({ type:'deluxe', count:parseInt(m[1]) });
    }
  }

  if (roomTypes.length > 0) {
    result.roomTypes = roomTypes;
    result.roomType = roomTypes[0].type;
    result.rooms = roomTypes.reduce((s, r) => s + r.count, 0);
  } else {
    // Fallback
    if (/honey|hon\b|hm\b/i.test(text)) result.roomType = "honeymoon";
    else if (/super|sdlx|sdx\b/i.test(text)) result.roomType = "superdeluxe";
    else if (/del|dlx|delx/i.test(text)) result.roomType = "deluxe";
    else result.roomType = null;
    const rm = text.match(/(\d+)\s*rooms?/i);
    const sharingRm = text.match(/room\s*sharing\s*[:=-]?\s*(\d+)/i);
    result.rooms = rm ? parseInt(rm[1]) : (sharingRm ? parseInt(sharingRm[1]) : (result.adults ? Math.ceil(result.adults / 3) : 1));
  }

  // -- Dates --------------------------------------------------------------
  const coKwRe = /(?:check[\s-]?out|checkout|co\b|c\/o|till|to\b|departure|until|upto)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
  const ciKwRe = /(?:check[\s-]?in|checkin|ci\b|c\/i|arrival|from)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;

  const coKw = text.match(coKwRe);
  const ciKw = text.match(ciKwRe);
  const dates = extractDates(text);
  const nightsM = text.match(/(\d+)\s*(?:n\b|nts\b|nights?|nites?)/i);
  const nights = nightsM ? parseInt(nightsM[1]) : null;

  if (ciKw && coKw) {
    const y = new Date().getFullYear();
    result.ciDate = toISO({ day:parseInt(ciKw[1]), month:MONTHS[ciKw[2].toLowerCase().slice(0,3)], year:y });
    result.coDate = toISO({ day:parseInt(coKw[1]), month:MONTHS[coKw[2].toLowerCase().slice(0,3)], year:y });
  } else if (dates.length >= 2) {
    const d1 = new Date(dates[0].year, dates[0].month, dates[0].day);
    const d2 = new Date(dates[1].year, dates[1].month, dates[1].day);
    result.ciDate = d1 <= d2 ? toISO(dates[0]) : toISO(dates[1]);
    result.coDate = d1 <= d2 ? toISO(dates[1]) : toISO(dates[0]);
  } else if (dates.length === 1) {
    result.ciDate = toISO(dates[0]);
    if (nights) {
      const d = new Date(dates[0].year, dates[0].month, dates[0].day);
      d.setDate(d.getDate() + nights);
      result.coDate = toISO({ day:d.getDate(), month:d.getMonth(), year:d.getFullYear() });
    } else if (coKw) {
      result.coDate = toISO({ day:parseInt(coKw[1]), month:MONTHS[coKw[2].toLowerCase().slice(0,3)], year:new Date().getFullYear() });
    } else {
      result.coDate = null;
    }
  } else {
    return null;
  }

  return result;
}

module.exports = { parseEnquiry };
