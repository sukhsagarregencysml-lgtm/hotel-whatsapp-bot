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

module.exports = { isAgent, getAgent, addAgent, removeAgent, listAgents, getAllAgents };
