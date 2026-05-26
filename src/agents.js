const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Agents";

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_SERVICE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getAllAgents() {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
    });
    const rows = res.data.values || [];
    return rows.slice(1).filter(r => r[0]).map(r => ({
      phone:    r[0]?.toString().trim(),
      name:     r[1]?.toString().trim() || "Agent",
      category: r[2]?.toString().trim().toUpperCase() || "C",
      addedOn:  r[3]?.toString().trim() || "",
    }));
  } catch (err) {
    console.error("✗ Failed to get agents:", err.message);
    return [];
  }
}

async function getAgent(phone) {
  const adminPhone = process.env.ADMIN_PHONE || "919816003322";
  if (phone === adminPhone) return { phone, name: "Admin", category: "A", isAdmin: true };
  const agents = await getAllAgents();
  return agents.find(a => a.phone === phone) || null;
}

async function isAgent(phone) {
  const agent = await getAgent(phone);
  return !!agent;
}

async function addAgent(phone, name, category = "C") {
  try {
    const agents = await getAllAgents();
    if (agents.some(a => a.phone === phone)) {
      return { success: false, message: `${phone} is already in the agent list` };
    }
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const date = new Date().toLocaleDateString("en-IN");
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, name, category.toUpperCase(), date]] },
    });
    return { success: true, message: `✅ *${name}* (${phone}) added as Category ${category.toUpperCase()} agent` };
  } catch (err) {
    return { success: false, message: `Failed to add agent: ${err.message}` };
  }
}

async function removeAgent(phone) {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0]?.toString().trim() === phone);
    if (rowIndex === -1) return { success: false, message: `${phone} not found in agent list` };
    const agentName = rows[rowIndex][1] || phone;
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A${rowIndex + 1}:D${rowIndex + 1}`,
    });
    return { success: true, message: `✅ *${agentName}* (${phone}) removed from agent list` };
  } catch (err) {
    return { success: false, message: `Failed to remove agent: ${err.message}` };
  }
}

async function listAgents() {
  const agents = await getAllAgents();
  if (agents.length === 0) return "📋 No agents yet.\n\nAdd one:\nADD AGENT 919876543210 Rahul Travels A";
  const lines = agents.map((a, i) => `${i + 1}. *${a.name}* — ${a.phone} — Cat ${a.category}`);
  return `📋 *Active Agents (${agents.length}):*\n\n${lines.join("\n")}\n\n_ADD AGENT 91XXXXXXXXXX Name A/B/C_\n_REMOVE AGENT 91XXXXXXXXXX_`;
}

// ── BOOKING TALLY (financial year tracking) ──────────────────
const TALLY_SHEET = "BookingTally";

function getFinancialYear() {
  const now = new Date();
  const month = now.getMonth(); // 0=Jan
  const year = now.getFullYear();
  // Financial year: April to March
  return month >= 3 ? `${year}-${year+1}` : `${year-1}-${year}`;
}

async function getTally(phone) {
  try {
    const fy = getFinancialYear();
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TALLY_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0]?.toString().trim() === phone && r[4]?.toString().trim() === fy);
    if (!row) return { phone, fy, roomsBooked: 0, freeRoomsEarned: 0, freeRoomsUsed: 0 };
    return {
      phone,
      fy,
      roomsBooked: parseInt(row[2] || 0),
      freeRoomsEarned: parseInt(row[3] || 0),
      freeRoomsUsed: parseInt(row[4] || 0),
      rowIndex: rows.indexOf(row),
    };
  } catch (err) {
    console.error("getTally error:", err.message);
    return { phone, fy: getFinancialYear(), roomsBooked: 0, freeRoomsEarned: 0, freeRoomsUsed: 0 };
  }
}

async function updateTally(phone, agentName, roomsToAdd) {
  try {
    const fy = getFinancialYear();
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Get current tally
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TALLY_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex(r => r[0]?.toString().trim() === phone && r[5]?.toString().trim() === fy);

    const currentRooms = rowIdx >= 0 ? parseInt(rows[rowIdx][2] || 0) : 0;
    const currentEarned = rowIdx >= 0 ? parseInt(rows[rowIdx][3] || 0) : 0;
    const currentUsed = rowIdx >= 0 ? parseInt(rows[rowIdx][4] || 0) : 0;

    const newRooms = currentRooms + roomsToAdd;
    const newEarned = Math.floor(newRooms / 10);
    const newlyEarned = newEarned - currentEarned;

    // Free rooms available = earned - used
    const freeRoomsAvailable = newEarned - currentUsed;

    const now = new Date().toLocaleDateString("en-IN");

    if (rowIdx >= 0) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TALLY_SHEET}!A${rowIdx + 1}:F${rowIdx + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[phone, agentName, newRooms, newEarned, currentUsed, fy]] },
      });
    } else {
      // Add new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${TALLY_SHEET}!A:F`,
        valueInputOption: "RAW",
        requestBody: { values: [[phone, agentName, newRooms, newEarned, 0, fy]] },
      });
    }

    return { newRooms, newEarned, newlyEarned, freeRoomsAvailable, currentUsed };
  } catch (err) {
    console.error("updateTally error:", err.message);
    return { newRooms: 0, newEarned: 0, newlyEarned: 0, freeRoomsAvailable: 0, currentUsed: 0 };
  }
}

async function useFreeRooms(phone, agentName, count) {
  try {
    const fy = getFinancialYear();
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TALLY_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex(r => r[0]?.toString().trim() === phone && r[5]?.toString().trim() === fy);
    if (rowIdx < 0) return false;
    const currentUsed = parseInt(rows[rowIdx][4] || 0);
    const newUsed = currentUsed + count;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TALLY_SHEET}!E${rowIdx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [[newUsed]] },
    });
    return true;
  } catch (err) {
    console.error("useFreeRooms error:", err.message);
    return false;
  }
}


// ── BLAST QUEUE SHEET ─────────────────────────────────────────────────────
const BLAST_SHEET = "BlastQueue";

async function initBlastSheet(phones, message) {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Clear existing data first
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });

    // Write header + all numbers as pending
    const header = [["Phone", "Status", "SentOn", "Retries", "Message", "AddedOn"]];
    const today = new Date().toLocaleDateString("en-IN");
    const rows = phones.map(p => [p, "pending", "", "0", message, today]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [...header, ...rows] },
    });

    console.log(`✓ BlastQueue sheet initialized with ${phones.length} numbers`);
    return true;
  } catch (err) {
    console.error("initBlastSheet error:", err.message);
    return false;
  }
}

async function loadBlastQueue() {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return null; // empty or header only

    const message = rows[1]?.[4] || null;
    const pending = [], failed = [], sent = [];

    rows.slice(1).forEach(r => {
      const phone = r[0]?.trim();
      const status = r[1]?.trim();
      if (!phone) return;
      if (status === "pending") pending.push(phone);
      else if (status === "failed") failed.push({ phone, retries: parseInt(r[3] || 0) });
      else if (status === "sent") sent.push(phone);
    });

    return { message, pending, failed, sentCount: sent.length };
  } catch (err) {
    console.error("loadBlastQueue error:", err.message);
    return null;
  }
}

async function markBlastSent(phones) {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });
    const rows = res.data.values || [];
    const today = new Date().toLocaleDateString("en-IN");

    const updates = [];
    phones.forEach(phone => {
      const idx = rows.findIndex((r, i) => i > 0 && r[0]?.trim() === phone);
      if (idx >= 0) {
        updates.push({
          range: `${BLAST_SHEET}!B${idx + 1}:C${idx + 1}`,
          values: [["sent", today]],
        });
      }
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
    return true;
  } catch (err) {
    console.error("markBlastSent error:", err.message);
    return false;
  }
}

async function markBlastFailed(phones) {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });
    const rows = res.data.values || [];

    const updates = [];
    phones.forEach(phone => {
      const idx = rows.findIndex((r, i) => i > 0 && r[0]?.trim() === phone);
      if (idx >= 0) {
        const retries = parseInt(rows[idx][3] || 0) + 1;
        updates.push({
          range: `${BLAST_SHEET}!B${idx + 1}:D${idx + 1}`,
          values: [["failed", "", String(retries)]],
        });
      }
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
    return true;
  } catch (err) {
    console.error("markBlastFailed error:", err.message);
    return false;
  }
}

async function resetFailedToPending() {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });
    const rows = res.data.values || [];

    const updates = [];
    rows.forEach((r, i) => {
      if (i === 0) return;
      if (r[1]?.trim() === "failed") {
        updates.push({
          range: `${BLAST_SHEET}!B${i + 1}`,
          values: [["pending"]],
        });
      }
    });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
    console.log(`♻️ Reset ${updates.length} failed numbers to pending`);
    return true;
  } catch (err) {
    console.error("resetFailedToPending error:", err.message);
    return false;
  }
}

async function clearBlastSheet() {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${BLAST_SHEET}!A:F`,
    });
    return true;
  } catch (err) {
    console.error("clearBlastSheet error:", err.message);
    return false;
  }
}

module.exports = { isAgent, getAgent, addAgent, removeAgent, listAgents, getAllAgents, getTally, updateTally, useFreeRooms, getFinancialYear, initBlastSheet, loadBlastQueue, markBlastSent, markBlastFailed, resetFailedToPending, clearBlastSheet };
