const axios = require("axios");

const SHEET_ID = process.env.AGENTS_SHEET_ID || process.env.GOOGLE_SHEET_ID || "1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog";
const API_KEY = process.env.GOOGLE_SHEETS_API_KEY || "AIzaSyCZbJjKgySFBC2hGvFvXkZTvnWZvwQz4pE";
const SHEET_NAME = "Agents";

// Sheet columns: A=Phone, B=Name, C=Category, D=Added On

let agentsCache = null;
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

async function getAllAgents() {
  if (agentsCache && Date.now() - cacheTime < CACHE_TTL) return agentsCache;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${SHEET_NAME}&range=A:D`;
    const res = await axios.get(url, { timeout: 10000 });
    const rows = res.data.split("\n").slice(1); // skip header row
    const agents = rows
      .map(r => r.split(",").map(c => c.replace(/"/g,"").trim()))
      .filter(r => r[0] && r[0].replace(/\D/g,"").length >= 10)
      .map(r => ({
        phone:    r[0].replace(/\D/g,""),
        name:     r[1] || "Travel Agent",
        category: (r[2] || "C").toUpperCase(),
        addedOn:  r[3] || "",
      }));
    const seen = new Set();
    const unique = agents.filter(a => { if(seen.has(a.phone)) return false; seen.add(a.phone); return true; });
    agentsCache = unique;
    cacheTime = Date.now();
    console.log(`✓ Loaded ${unique.length} agents from sheet`);
    return unique;
  } catch(csvErr) {
    console.error("CSV fetch failed:", csvErr.message);
    try {
      const url2 = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_NAME}!A:D?key=${API_KEY}`;
      const res2 = await axios.get(url2, { timeout: 10000 });
      const rows = (res2.data?.values || []).slice(1);
      const agents = rows.filter(r => r[0]).map(r => ({
        phone:    r[0].toString().trim().replace(/\D/g,""),
        name:     r[1]?.toString().trim() || "Travel Agent",
        category: (r[2]?.toString().trim() || "C").toUpperCase(),
        addedOn:  r[3]?.toString().trim() || "",
      }));
      agentsCache = agents;
      cacheTime = Date.now();
      return agents;
    } catch(apiErr) {
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

async function isAgent(phone) { return !!(await getAgent(phone)); }

async function addAgent(phone, name, category = "C") {
  try {
    agentsCache = null;
    const agents = await getAllAgents();
    if (agents.some(a => a.phone === phone)) {
      return { success: false, message: `${phone} is already in the agent list` };
    }
    const newAgent = { phone: phone.replace(/\D/g,""), name, category: category.toUpperCase(), addedOn: new Date().toLocaleDateString("en-IN") };
    if (!agentsCache) agentsCache = [...agents];
    agentsCache.push(newAgent);

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
          spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:D`,
          valueInputOption: "RAW",
          requestBody: { values: [[phone, name, category.toUpperCase(), new Date().toLocaleDateString("en-IN")]] },
        });
        console.log(`✓ Agent ${phone} written to sheet`);
      } catch(e) { console.log("Sheet write failed:", e.message); }
    }
    return { success: true, message: `✅ *${name}* (${phone}) added as Category ${category.toUpperCase()}` };
  } catch(err) { return { success: false, message: `Failed: ${err.message}` }; }
}

async function removeAgent(phone) {
  agentsCache = null;
  if (!process.env.GOOGLE_SERVICE_EMAIL) return { success: false, message: "Write credentials not set" };
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: process.env.GOOGLE_SERVICE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:D` });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[0]?.replace(/\D/g,"") === phone.replace(/\D/g,""));
    if (rowIndex === -1) return { success: false, message: `${phone} not found` };
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A${rowIndex+1}:D${rowIndex+1}` });
    return { success: true, message: `✅ ${rows[rowIndex][1] || phone} removed` };
  } catch(err) { return { success: false, message: `Failed: ${err.message}` }; }
}

async function listAgents() {
  const agents = await getAllAgents();
  if (!agents.length) return "📋 No agents found.";
  return `📋 *Agents (${agents.length}):*\n\n${agents.slice(0,20).map((a,i)=>`${i+1}. *${a.name}* — ${a.phone} — Cat ${a.category}`).join("\n")}`;
}

async function getTally(phone) { return { roomsBooked: 0, freeRoomsUsed: 0 }; }
async function updateTally(phone, name, rooms) { return { success: true, newRooms: 0, newlyEarned: 0 }; }
async function useFreeRooms(phone, count) { return { success: true }; }

module.exports = { isAgent, getAgent, addAgent, removeAgent, listAgents, getAllAgents, getTally, updateTally, useFreeRooms };
