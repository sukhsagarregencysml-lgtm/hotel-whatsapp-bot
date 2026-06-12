const MONTHS = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,
  jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,
  nov:10,november:10,dec:11,december:11
};

const DAYS_OF_WEEK = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// ── Normalize text before parsing ──────────────────────────────
function normalizeText(text) {
  return text
    // Ordinals: "1st" → "1", "22nd" → "22"
    .replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    // "of month": "1 of july" → "1 july"
    .replace(/(\d{1,2})\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec\w*)/gi, '$1 $2')
    // Check in/out variants
    .replace(/check\s*[-]?\s*in\b/gi, 'checkin')
    .replace(/check\s*[-]?\s*out\b/gi, 'checkout')
    .replace(/\barrival\b/gi, 'checkin')
    .replace(/\bdeparture\b|\bleave\b|\bleaving\b|\bgoing\s+back\b|\breturn\b/gi, 'checkout')
    .replace(/\bc\/i\b/gi, 'checkin')
    .replace(/\bc\/o\b/gi, 'checkout')
    // "want to come on" → "checkin"
    .replace(/(?:want\s+to\s+come|coming|arriving|reach|reaching)\s+(?:on\s+)?/gi, 'checkin ')
    .replace(/(?:want\s+to\s+leave|going|leaving|going\s+back|returning)\s+(?:on\s+)?/gi, 'checkout ')
    // "from X to Y" — already handled by extractDates
    // Nights: "2 nights from" → keep
    // "next monday", "this friday" etc handled separately
    // Remove extra spaces
    .replace(/\s+/g, ' ').trim();
}

// ── Relative date resolution ────────────────────────────────────
function resolveRelativeDate(text) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const lower = text.toLowerCase();

  // "today"
  if (/\btoday\b/.test(lower)) return new Date(today);

  // "tomorrow"
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d;
  }

  // "day after tomorrow"
  if (/\bday\s+after\s+tomorrow\b/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() + 2); return d;
  }

  // "next week" → 7 days from now
  if (/\bnext\s+week\b/.test(lower)) {
    const d = new Date(today); d.setDate(d.getDate() + 7); return d;
  }

  // "this weekend" → next Saturday
  if (/\bthis\s+weekend\b|\bweekend\b/.test(lower)) {
    const d = new Date(today);
    const daysUntilSat = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilSat); return d;
  }

  // "next monday/tuesday/..."
  const nextDayM = lower.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (nextDayM) {
    const targetDay = DAYS_OF_WEEK.indexOf(nextDayM[1]);
    const d = new Date(today);
    const diff = (targetDay - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff); return d;
  }

  // "this monday/tuesday/..." → closest upcoming
  const thisDayM = lower.match(/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (thisDayM) {
    const targetDay = DAYS_OF_WEEK.indexOf(thisDayM[1]);
    const d = new Date(today);
    let diff = (targetDay - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff); return d;
  }

  // "in X days"
  const inDaysM = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDaysM) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(inDaysM[1])); return d;
  }

  return null;
}

function dateToISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Extract dates ───────────────────────────────────────────────
function extractDates(text) {
  const dates = [];
  const yr = new Date().getFullYear();

  // "22 24 july", "22 to 24 july", "22-24 july"
  const sharedMonthRe = /(\d{1,2})\s*(?:(?:to|till|until|upto|[-–])\s*|\s+)(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*(\d{4}))?/gi;
  let sharedM;
  while ((sharedM = sharedMonthRe.exec(text)) !== null) {
    const day1 = parseInt(sharedM[1]), day2 = parseInt(sharedM[2]);
    const mon = MONTHS[sharedM[3].toLowerCase().slice(0,3)];
    const year = sharedM[4] ? parseInt(sharedM[4]) : yr;
    if (mon !== undefined && day1 >= 1 && day1 <= 31 && day2 >= 1 && day2 <= 31) {
      dates.push({ day: day1, month: mon, year });
      dates.push({ day: day2, month: mon, year });
    }
  }

  // "22july", "22nd july", "22 july 2026"
  const wordRe = /(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*(\d{4}))?/gi;
  let m;
  while ((m = wordRe.exec(text)) !== null) {
    const day = parseInt(m[1]);
    const mon = MONTHS[m[2].toLowerCase().slice(0,3)];
    const year = m[3] ? parseInt(m[3]) : yr;
    if (mon !== undefined && day >= 1 && day <= 31)
      if (!dates.find(d => d.day === day && d.month === mon))
        dates.push({ day, month: mon, year });
  }

  // Numeric: "22/7", "22-07-2026"
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

// ── Extract guest counts ────────────────────────────────────────
function extractGuestCounts(text) {
  const guests = {};

  // Adults
  const adultsM =
    text.match(/(\d+)\s*adults?\b/i) ||
    text.match(/(\d+)\s*pax\b/i) ||
    text.match(/(\d+)\s*persons?\b/i) ||
    text.match(/(\d+)\s*people\b/i) ||
    text.match(/family\s+of\s+(\d+)/i) ||
    text.match(/group\s+of\s+(\d+)/i);
  if (adultsM) guests.adults = parseInt(adultsM[1]);

  // Kids
  const kidsM =
    text.match(/(\d+)\s*(?:kids?|children|child|childs?)\b/i) ||
    text.match(/(?:kids?|children)\s*[:=]\s*(\d+)/i);
  if (kidsM) guests.kids = parseInt(kidsM[1]);

  // Kid ages
  const kidsLineM = text.match(/(?:kids?|children|child)[^\n]*(?:ages?|yrs?|years?)[^\n]*/i);
  if (kidsLineM) {
    const agesText = kidsLineM[0];
    const ages = [];
    let ageM;
    const ageRe = /\d+(?:\.\d+)?/g;
    while ((ageM = ageRe.exec(agesText)) !== null) ages.push(parseFloat(ageM[0]));
    if (ages.length > 0) { guests.kidAges = ages; if (!guests.kids) guests.kids = ages.length; }
  }

  return guests;
}

// ── Main parseEnquiry ───────────────────────────────────────────
function parseEnquiry(text) {
  if (!text || text.trim().length < 4) return null;

  // Normalize
  text = normalizeText(text);
  const lower = text.toLowerCase();

  // Must have date or booking keyword
  const hasDate = /\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d[\/\-.]\d)/i.test(text);
  const hasRelDate = /\btoday\b|\btomorrow\b|\bnext\s+week\b|\bthis\s+weekend\b|\bnext\s+(mon|tue|wed|thu|fri|sat|sun)\w*\b|\bin\s+\d+\s+days?\b/i.test(text);
  const hasBookingWord = /book|room|availab|enquir|need|check|night|price|rate|del|dlx|honey|super|sd\b|cp\b|map\b|ep\b|stay|visit|trip|tour|holiday|shimla|hotel/i.test(text);

  if (!hasDate && !hasRelDate && !hasBookingWord) return null;

  const result = {};
  Object.assign(result, extractGuestCounts(text));

  // ── Plan ──────────────────────────────────────────────────────
  if (/\bMAPAI\b/i.test(text)) result.plan = "MAPAI";
  else if (/\bMAP\b/i.test(text)) result.plan = "MAP";
  else if (/\bCPAI\b/i.test(text)) result.plan = "CP";
  else if (/\bCP\b/i.test(text)) result.plan = "CP";
  else if (/\bEP\b/i.test(text)) result.plan = "EP";
  // Natural language plan hints
  else if (/\bbreakfast\s+(?:and\s+)?dinner\b/i.test(text)) result.plan = "MAP";
  else if (/\bbreakfast\s+only\b|\bonly\s+breakfast\b/i.test(text)) result.plan = "CP";
  else if (/\bno\s+(?:food|meal|meals)\b|\broom\s+only\b|\bonly\s+room\b/i.test(text)) result.plan = "EP";
  else result.plan = null;

  // ── Room types ────────────────────────────────────────────────
  const roomTypes = [];
  const sdRe = /(\d+)\s*(?:super\s*del(?:u(?:x(?:e)?)?)?|s\.?\s*d(?:lx|x)?\b|sdlx|sdx|spdlx)/gi;
  const honRe = /(\d+)\s*(?:hon(?:ey(?:moon)?)?|hm\b|hmoon)/gi;
  const dlxRe = /(\d+)\s*(?:del(?:u(?:x(?:e)?)?)?|dlx|delx)\b/gi;
  let m;
  while ((m = sdRe.exec(text)) !== null) roomTypes.push({ type: 'superdeluxe', count: parseInt(m[1]) });
  while ((m = honRe.exec(text)) !== null) roomTypes.push({ type: 'honeymoon', count: parseInt(m[1]) });
  const textNSD = text.replace(/\d+\s*(?:super\s*del\w*|s\.?\s*d(?:lx|x)?\b|sdlx|sdx|spdlx)/gi, '');
  while ((m = dlxRe.exec(textNSD)) !== null) roomTypes.push({ type: 'deluxe', count: parseInt(m[1]) });

  // "2 rooms super deluxe" pattern
  if (roomTypes.length === 0) {
    const roomsFirstRe = /(\d+)\s*rooms?\s+(\w+)/gi;
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
    if (/honey|hon\b|hm\b/i.test(text)) result.roomType = "honeymoon";
    else if (/super|sdlx|sdx\b/i.test(text)) result.roomType = "superdeluxe";
    else if (/del|dlx|delx/i.test(text)) result.roomType = "deluxe";
    else result.roomType = null;

    const rm = text.match(/(\d+)\s*rooms?/i);
    result.rooms = rm ? parseInt(rm[1]) : (result.adults ? Math.ceil(result.adults / 3) : 1);
  }

  // ── Dates ─────────────────────────────────────────────────────
  const yr = new Date().getFullYear();
  const nightsM = text.match(/(\d+)\s*(?:n\b|nts\b|nights?|nites?)/i);
  const nights = nightsM ? parseInt(nightsM[1]) : null;

  // Check for relative dates in original (pre-normalize) message
  const relCI = resolveRelativeDate(
    text.match(/checkin\s+(.+?)(?:checkout|$)/i)?.[1] || ''
  );
  const relCO = resolveRelativeDate(
    text.match(/checkout\s+(.+?)$/i)?.[1] || ''
  );

  // Keyword-based date extraction
  const ciKwRe = /(?:checkin|ci\b)\s*(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
  const coKwRe = /(?:checkout|co\b|till\b|until\b)\s*(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
  const ciKw = text.match(ciKwRe);
  const coKw = text.match(coKwRe);
  const dates = extractDates(text);

  if (ciKw && coKw) {
    result.ciDate = toISO({ day:parseInt(ciKw[1]), month:MONTHS[ciKw[2].toLowerCase().slice(0,3)], year:yr });
    result.coDate = toISO({ day:parseInt(coKw[1]), month:MONTHS[coKw[2].toLowerCase().slice(0,3)], year:yr });
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
      result.coDate = dateToISO(d);
    } else if (coKw) {
      result.coDate = toISO({ day:parseInt(coKw[1]), month:MONTHS[coKw[2].toLowerCase().slice(0,3)], year:yr });
    } else {
      result.coDate = null;
    }
  } else if (relCI) {
    result.ciDate = dateToISO(relCI);
    if (relCO) {
      result.coDate = dateToISO(relCO);
    } else if (nights) {
      const d = new Date(relCI); d.setDate(d.getDate() + nights);
      result.coDate = dateToISO(d);
    } else {
      result.coDate = null;
    }
  } else {
    return null;
  }

  // Fix year rollover — if date is in past, push to next year
  if (result.ciDate) {
    const today = new Date(); today.setHours(0,0,0,0);
    const ci = new Date(result.ciDate);
    if (ci < today) {
      ci.setFullYear(ci.getFullYear() + 1);
      result.ciDate = dateToISO(ci);
      if (result.coDate) {
        const co = new Date(result.coDate);
        co.setFullYear(co.getFullYear() + 1);
        result.coDate = dateToISO(co);
      }
    }
  }

  return result;
}

module.exports = { parseEnquiry };
