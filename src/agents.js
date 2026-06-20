const axios = require("axios");

const SHEET_ID = process.env.AGENTS_SHEET_ID || process.env.GOOGLE_SHEET_ID || "1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog";
const SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY || "AIzaSyCZbJjKgySFBC2hGvFvXkZTvnWZvwQz4pE";
const SHEET_NAME = "Agents";

// Cache to avoid hitting API on every message
let agentsCache = null;
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function getAllAgents() {
  if (agentsCache && Date.now() - cacheTime < CACHE_TTL) return agentsCache;

  try {
    // CSV export — works with just public sheet, no OAuth
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${SHEET_NAME}&range=A:D`;
    const res = await axios.get(csvUrl, { timeout: 10000 });
    const rows = res.data.split("\n").slice(1);
    const agents = rows
      .map(r => r.split(",").map(c => c.replace(/"/g, "").trim()))
      .filter(r => r[0] && r[0].replace(/\D/g,"").length >= 10)
      .map(r => ({
        phone:    r[0].replace(/\D/g, ""),
        name:     r[1] || "Agent",
        category: (r[2] || "C").toUpperCase(),
        addedOn:  r[3] || "",
      }));
    agentsCache = agents;
    cacheTime = Date.now();
    console.log(`✓ Loaded ${agents.length} agents from sheet`);
    return agents;
  } catch (csvErr) {
    // Fallback: API key
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_NAME}!A:D?key=${SHEETS_API_KEY}`;
      const res2 = await axios.get(url, { timeout: 10000 });
      const rows = (res2.data?.values || []).slice(1);
      const agents = rows.filter(r => r[0]).map(r => ({
        phone:    r[0].toString().trim().replace(/\D/g,""),
        name:     r[1]?.toString().trim() || "Agent",
        category: (r[2]?.toString().trim() || "C").toUpperCase(),
        addedOn:  r[3]?.toString().trim() || "",
      }));
      agentsCache = agents;
      cacheTime = Date.now();
      return agents;
    } catch (apiErr) {
      console.error("✗ Failed to get agents:", apiErr.message);
      return agentsCache || [];
    }
  }
}

async function getAgent(phone) {
  const adminPhone = process.env.ADMIN_PHONE || "919816003322";
  if (phone === adminPhone) return { phone, name: "Admin", category: "A", isAdmin: true };
  const agents = await getAllAgents();
  return agents.find(a => a.phone === phone) || null;
}

async function isAgent(phone) {
  return !!(await getAgent(phone));
}

async function addAgent(phone, name, category = "C") {
  try {
    agentsCache = null; // Clear cache
    const agents = await getAllAgents();
    if (agents.some(a => a.phone === phone)) {
      return { success: false, message: `${phone} is already in the agent list` };
    }

    // Add to cache immediately
    const newAgent = { phone: phone.replace(/\D/g,""), name, category: category.toUpperCase(), addedOn: new Date().toLocaleDateString("en-IN") };
    if (agentsCache) agentsCache.push(newAgent);

    // Write to sheet if credentials available
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_SERVICE_KEY) {
      try {
        const { google } = require("googleapis");
        const auth = new google.auth.JWT({
          email: process.env.GOOGLE_SERVICE_EMAIL,
          key: process.env.GOOGLE_SERVICE_KEY.replace(/\\n/g, "\n"),
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const sheets = google.sheets({ version: "v4", auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_NAME}!A:D`,
          valueInputOption: "RAW",
          requestBody: { values: [[phone, name, category.toUpperCase(), new Date().toLocaleDateString("en-IN")]] },
        });
        console.log(`✓ Agent ${phone} written to Google Sheet`);
      } catch(e) { console.log(`⚠ Sheet write failed: ${e.message}`); }
    }

    return { success: true, message: `✅ *${name}* (${phone}) added as Category ${category.toUpperCase()} agent` };
  } catch (err) {
    return { success: false, message: `Failed to add agent: ${err.message}` };
  }
}

async function removeAgent(phone) {
  try {
    agentsCache = null;
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_SERVICE_KEY) {
      const { google } = require("googleapis");
      const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_EMAIL,
        key: process.env.GOOGLE_SERVICE_KEY.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const sheets = google.sheets({ version: "v4", auth });
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:D` });
      const rows = res.data.values || [];
      const rowIndex = rows.findIndex((r, i) => i > 0 && r[0]?.toString().trim().replace(/\D/g,"") === phone.replace(/\D/g,""));
      if (rowIndex === -1) return { success: false, message: `${phone} not found` };
      const agentName = rows[rowIndex][1] || phone;
      await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowIndex+1}:D${rowIndex+1}` });
      return { success: true, message: `✅ *${agentName}* removed from agent list` };
    }
    return { success: false, message: "Write credentials not set" };
  } catch (err) {
    return { success: false, message: `Failed to remove: ${err.message}` };
  }
}

async function listAgents() {
  const agents = await getAllAgents();
  if (!agents.length) return "📋 No agents yet.\n\nAdd: ADD AGENT 919876543210 Name A";
  const lines = agents.map((a, i) => `${i+1}. *${a.name}* — ${a.phone} — Cat ${a.category}`);
  return `📋 *Agents (${agents.length}):*\n\n${lines.join("\n")}`;
}

// Tally functions (keep existing)
async function getTally(phone) {
  try {
    const agents = await getAllAgents();
    const agent = agents.find(a => a.phone === phone);
    return { roomsBooked: parseInt(agent?.roomsBooked || 0), freeRoomsUsed: parseInt(agent?.freeRoomsUsed || 0) };
  } catch(e) { return { roomsBooked: 0, freeRoomsUsed: 0 }; }
}

async function updateTally(phone, name, rooms) {
  return { success: true, newRooms: 0, newlyEarned: 0 };
}

async function useFreeRooms(phone, count) {
  return { success: true };
}

module.exports = { isAgent, getAgent, addAgent, removeAgent, listAgents, getAllAgents, getTally, updateTally, useFreeRooms };
