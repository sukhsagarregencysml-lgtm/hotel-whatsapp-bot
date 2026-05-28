// ════════════════════════════════════════════════════════════════
// GUEST SERVICES MODULE — Interactive Buttons & Lists
// ════════════════════════════════════════════════════════════════

const SERVICES_CONFIG = {
  TASK_TIMEOUT_STAFF: 5 * 60 * 1000,
  TASK_TIMEOUT_HOD:   15 * 60 * 1000,
  HOD_PHONES: {
    housekeeping: process.env.HOD_HOUSEKEEPING || '919816003322',
    food:         process.env.HOD_FOOD         || '919816003322',
    frontdesk:    process.env.HOD_FRONTDESK    || '919816003322',
    maintenance:  process.env.HOD_MAINTENANCE  || '919816003322',
    laundry:      process.env.HOD_LAUNDRY      || '919816003322',
  },
  GOOGLE_REVIEW_LINK: process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_REVIEW_LINK',
  PMS_URL: process.env.PMS_URL || 'https://hotelease-backend-fhba.onrender.com',
};

const activeTasks      = {};
const guestRoomMap     = {};
const feedbackSessions = {};
const guestServiceSessions = {};

let taskCounter = 1;

// ── DEPARTMENTS ───────────────────────────────────────────────────
// WhatsApp list rows: title max 24 chars, description max 72 chars
const DEPARTMENTS = {
  'dept_hk': {
    dept: 'housekeeping', label: '🛏 Housekeeping',
    items: [
      { id: 'hk_1',  title: 'Room cleaning',       desc: 'Make bed & clean room' },
      { id: 'hk_2',  title: 'Fresh bed sheets',     desc: 'Change bed sheets & covers' },
      { id: 'hk_3',  title: 'Extra pillows',        desc: 'Additional pillows' },
      { id: 'hk_4',  title: 'Extra blanket',        desc: 'Extra blanket or quilt' },
      { id: 'hk_5',  title: 'Fresh bath towels',    desc: 'Fresh bath towels' },
      { id: 'hk_6',  title: 'Fresh hand towels',    desc: 'Hand or face towels' },
      { id: 'hk_7',  title: 'Toilet paper',         desc: 'Toilet paper or tissues' },
      { id: 'hk_8',  title: 'Soap & hand wash',     desc: 'Soap, sanitizer' },
      { id: 'hk_9',  title: 'Shampoo & conditioner',desc: 'Hair care products' },
      { id: 'hk_10', title: 'Toothbrush & paste',   desc: 'Dental kit' },
    ]
  },
  'dept_hk2': {
    dept: 'housekeeping', label: '🛏 Housekeeping (more)',
    items: [
      { id: 'hk_11', title: 'Comb & hair brush',    desc: 'Hair accessories' },
      { id: 'hk_12', title: 'Shaving kit',          desc: 'Razor, shaving foam' },
      { id: 'hk_13', title: 'Room freshener',       desc: 'Air freshener spray' },
      { id: 'hk_14', title: 'Do Not Disturb',       desc: 'Please do not disturb' },
      { id: 'hk_15', title: 'Baby cot / crib',      desc: 'Baby bed arrangement' },
      { id: 'hk_16', title: 'Extra hangers',        desc: 'Clothes hangers' },
      { id: 'hk_17', title: 'Iron & ironing board', desc: 'Clothes ironing' },
      { id: 'hk_18', title: 'Slippers',             desc: 'Room slippers' },
      { id: 'hk_19', title: 'Bathrobe',             desc: 'Bathrobe request' },
      { id: 'hk_20', title: 'Turn down service',    desc: 'Evening room prep' },
    ]
  },
  'dept_food': {
    dept: 'food', label: '🍽 Food & Beverages',
    items: [
      { id: 'fd_1',  title: 'Morning tea / coffee', desc: 'Hot tea or coffee' },
      { id: 'fd_2',  title: 'Bed tea',              desc: 'Tea in bed' },
      { id: 'fd_3',  title: 'Breakfast in room',    desc: 'Full breakfast' },
      { id: 'fd_4',  title: 'Lunch in room',        desc: 'Lunch delivery' },
      { id: 'fd_5',  title: 'Dinner in room',       desc: 'Dinner delivery' },
      { id: 'fd_6',  title: 'Evening snacks',       desc: 'Snacks & biscuits' },
      { id: 'fd_7',  title: 'Bottled water',        desc: 'Mineral water' },
      { id: 'fd_8',  title: 'Fresh juice',          desc: 'Fresh fruit juice' },
      { id: 'fd_9',  title: 'Cold drinks',          desc: 'Soft drinks & beverages' },
      { id: 'fd_10', title: 'Nimbu pani / lassi',   desc: 'Indian beverages' },
    ]
  },
  'dept_food2': {
    dept: 'food', label: '🍽 Food (more)',
    items: [
      { id: 'fd_11', title: 'Soup',                 desc: 'Hot soup' },
      { id: 'fd_12', title: 'Sandwiches',           desc: 'Veg / non-veg sandwich' },
      { id: 'fd_13', title: 'Paranthas',            desc: 'With curd & pickle' },
      { id: 'fd_14', title: 'Maggi / noodles',      desc: 'Quick snack' },
      { id: 'fd_15', title: 'Fruit plate',          desc: 'Seasonal fruits' },
      { id: 'fd_16', title: 'Ice cream',            desc: 'Ice cream / dessert' },
      { id: 'fd_17', title: 'Birthday cake',        desc: 'Special occasion cake' },
      { id: 'fd_18', title: 'Candle light dinner',  desc: 'Romantic dinner setup' },
      { id: 'fd_19', title: 'Dry fruits & nuts',    desc: 'Healthy snack' },
      { id: 'fd_20', title: 'Other food request',   desc: 'Type your request' },
    ]
  },
  'dept_mt': {
    dept: 'maintenance', label: '🔧 Maintenance',
    items: [
      { id: 'mt_1',  title: 'AC not working',       desc: 'AC issue or temperature' },
      { id: 'mt_2',  title: 'AC remote missing',    desc: 'Need AC remote' },
      { id: 'mt_3',  title: 'TV not working',       desc: 'TV or remote issue' },
      { id: 'mt_4',  title: 'WiFi not connecting',  desc: 'Internet issue' },
      { id: 'mt_5',  title: 'WiFi password',        desc: 'Need WiFi password' },
      { id: 'mt_6',  title: 'Lights not working',   desc: 'Electricity issue' },
      { id: 'mt_7',  title: 'Hot water issue',      desc: 'Geyser not working' },
      { id: 'mt_8',  title: 'Tap / shower leak',    desc: 'Water leakage' },
      { id: 'mt_9',  title: 'Flush not working',    desc: 'Toilet flush issue' },
      { id: 'mt_10', title: 'Power socket issue',   desc: 'Charging point issue' },
    ]
  },
  'dept_mt2': {
    dept: 'maintenance', label: '🔧 Maintenance (more)',
    items: [
      { id: 'mt_11', title: 'Fridge not working',   desc: 'Mini fridge issue' },
      { id: 'mt_12', title: 'Safe locker issue',    desc: 'Room safe problem' },
      { id: 'mt_13', title: 'Door lock issue',      desc: 'Door or key card' },
      { id: 'mt_14', title: 'Window / curtain',     desc: 'Window or curtain issue' },
      { id: 'mt_15', title: 'Pest / insect',        desc: 'Pest control needed' },
      { id: 'mt_16', title: 'Drain blocked',        desc: 'Water not draining' },
      { id: 'mt_17', title: 'Other maintenance',    desc: 'Type your issue' },
    ]
  },
  'dept_fd': {
    dept: 'frontdesk', label: '📞 Front Desk',
    items: [
      { id: 'fs_1',  title: 'Bill / invoice',       desc: 'Request your bill' },
      { id: 'fs_2',  title: 'Early check-in',       desc: 'Request early check-in' },
      { id: 'fs_3',  title: 'Late check-out',       desc: 'Request late check-out' },
      { id: 'fs_4',  title: 'Room upgrade',         desc: 'Upgrade room type' },
      { id: 'fs_5',  title: 'Extra bed',            desc: 'Additional bed needed' },
      { id: 'fs_6',  title: 'Wake-up call',         desc: 'Morning wake-up call' },
      { id: 'fs_7',  title: 'Newspaper',            desc: 'Daily newspaper' },
      { id: 'fs_8',  title: 'Luggage assistance',   desc: 'Help with luggage' },
      { id: 'fs_9',  title: 'Doctor on call',       desc: 'Medical assistance' },
      { id: 'fs_10', title: 'Medicine / first aid', desc: 'First aid kit' },
    ]
  },
  'dept_fd2': {
    dept: 'frontdesk', label: '📞 Front Desk (more)',
    items: [
      { id: 'fs_11', title: 'Cab / taxi booking',   desc: 'Local taxi' },
      { id: 'fs_12', title: 'Airport drop',         desc: 'Drop to airport/station' },
      { id: 'fs_13', title: 'Airport pickup',       desc: 'Pickup from airport' },
      { id: 'fs_14', title: 'Sightseeing info',     desc: 'Local tour packages' },
      { id: 'fs_15', title: 'Baby sitting',         desc: 'Child care arrangement' },
      { id: 'fs_16', title: 'Photocopy / print',    desc: 'Document services' },
      { id: 'fs_17', title: 'Courier / postal',     desc: 'Send a parcel' },
      { id: 'fs_18', title: 'Other request',        desc: 'Any other assistance' },
    ]
  },
  'dept_ly': {
    dept: 'laundry', label: '👗 Laundry',
    items: [
      { id: 'ly_1',  title: 'Laundry pickup',       desc: 'Collect clothes for wash' },
      { id: 'ly_2',  title: 'Dry cleaning',         desc: 'Dry clean service' },
      { id: 'ly_3',  title: 'Express laundry',      desc: 'Same day delivery' },
      { id: 'ly_4',  title: 'Ironing only',         desc: 'Press clothes only' },
      { id: 'ly_5',  title: 'Stain removal',        desc: 'Stain treatment' },
      { id: 'ly_6',  title: 'Other laundry',        desc: 'Type your request' },
    ]
  },
};

// item id → service label mapping
const ITEM_MAP = {};
Object.values(DEPARTMENTS).forEach(dept => {
  dept.items.forEach(item => {
    ITEM_MAP[item.id] = { service: `${dept.label}: ${item.title}`, dept: dept.dept, isCustom: item.id.endsWith('_custom') || item.title.toLowerCase().includes('other') };
  });
});

// ── REGISTER GUEST ────────────────────────────────────────────────
function registerGuestForServices(phone, guestName, hotelName, roomNumber, checkoutDate) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const waPhone = cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone;
  guestRoomMap[waPhone] = { roomNumber, guestName, hotelName, checkoutDate, registeredAt: new Date().toISOString() };
  console.log(`✅ Guest registered: ${waPhone} → Room ${roomNumber}`);
}

// ── SEND MAIN MENU (with buttons) ────────────────────────────────
async function sendServiceMenu(phone, wa) {
  const guest = guestRoomMap[phone];
  const name = guest ? guest.guestName : 'Guest';
  const room = guest ? ` (Room ${guest.roomNumber})` : '';

  // 3 buttons for main categories + list for more
  await wa.sendButtonMessage(
    phone,
    `Dear *${name}*${room},\n\nHow can we help you today? 😊\n\nTap a button or reply *MENU* anytime.`,
    [
      { id: 'menu_hk',   title: '🛏 Housekeeping' },
      { id: 'menu_food', title: '🍽 Food & Beverages' },
      { id: 'menu_more', title: '📋 More Services' },
    ],
    `🏨 Guest Services`,
    `Available 24/7 for your comfort`
  );
}

// ── SEND MORE SERVICES LIST ───────────────────────────────────────
async function sendMoreServicesMenu(phone, wa) {
  await wa.sendListMessage(
    phone,
    `Select a service department:`,
    '📋 View Services',
    [
      { title: 'Hotel Services', rows: [
        { id: 'menu_mt', title: '🔧 Maintenance',    description: 'AC, TV, electricity, plumbing' },
        { id: 'menu_fd', title: '📞 Front Desk',     description: 'Bill, cab, luggage, doctor' },
        { id: 'menu_ly', title: '👗 Laundry',        description: 'Wash, dry clean, iron' },
        { id: 'menu_fb', title: '⭐ Feedback',       description: 'Rate your stay' },
      ]}
    ],
    '🏨 More Services'
  );
}

// ── SEND HOUSEKEEPING LIST ────────────────────────────────────────
async function sendHousekeepingList(phone, wa) {
  await wa.sendListMessage(
    phone,
    `What do you need from Housekeeping?\n\nTap to select:`,
    '🛏 Select Service',
    [
      { title: '🛏 Room & Bedding', rows: DEPARTMENTS['dept_hk'].items },
      { title: '🛁 More Items',     rows: DEPARTMENTS['dept_hk2'].items },
    ],
    '🛏 Housekeeping'
  );
}

// ── SEND FOOD LIST ────────────────────────────────────────────────
async function sendFoodList(phone, wa) {
  await wa.sendListMessage(
    phone,
    `What would you like from Room Service?\n\nTap to select:`,
    '🍽 Select Item',
    [
      { title: '☕ Drinks & Breakfast', rows: DEPARTMENTS['dept_food'].items },
      { title: '🍱 Food & More',        rows: DEPARTMENTS['dept_food2'].items },
    ],
    '🍽 Food & Beverages'
  );
}

// ── SEND MAINTENANCE LIST ─────────────────────────────────────────
async function sendMaintenanceList(phone, wa) {
  await wa.sendListMessage(
    phone,
    `What issue are you facing?\n\nTap to select:`,
    '🔧 Select Issue',
    [
      { title: '🔧 Common Issues', rows: DEPARTMENTS['dept_mt'].items },
      { title: '🔧 More Issues',   rows: DEPARTMENTS['dept_mt2'].items },
    ],
    '🔧 Maintenance'
  );
}

// ── SEND FRONT DESK LIST ──────────────────────────────────────────
async function sendFrontDeskList(phone, wa) {
  await wa.sendListMessage(
    phone,
    `How can Front Desk assist you?\n\nTap to select:`,
    '📞 Select Service',
    [
      { title: '📞 Front Desk',      rows: DEPARTMENTS['dept_fd'].items },
      { title: '🚗 Travel & More',   rows: DEPARTMENTS['dept_fd2'].items },
    ],
    '📞 Front Desk'
  );
}

// ── SEND LAUNDRY LIST ─────────────────────────────────────────────
async function sendLaundryList(phone, wa) {
  await wa.sendListMessage(
    phone,
    `Select laundry service:`,
    '👗 Select Service',
    [{ title: '👗 Laundry Services', rows: DEPARTMENTS['dept_ly'].items }],
    '👗 Laundry'
  );
}

// ── CREATE TASK ───────────────────────────────────────────────────
async function createTask(phone, dept, service, wa) {
  const guest = guestRoomMap[phone] || { roomNumber: '?', guestName: 'Guest', hotelName: 'Hotel' };
  const taskId = 'T' + String(taskCounter++).padStart(4, '0');
  const hodPhone = SERVICES_CONFIG.HOD_PHONES[dept] || SERVICES_CONFIG.HOD_PHONES.frontdesk;

  const task = {
    id: taskId, phone,
    guestName: guest.guestName,
    roomNumber: guest.roomNumber,
    hotelName: guest.hotelName,
    dept, service,
    status: 'pending',
    createdAt: new Date(),
    hodNotified: false,
    adminNotified: false,
  };
  activeTasks[taskId] = task;

  // Confirm to guest with button to request another service
  await wa.sendButtonMessage(
    phone,
    `✅ *Request Received!*\n\nID: *${taskId}*\nService: ${service.split(': ').pop()}\nRoom: ${guest.roomNumber}\n\nOur staff will attend to you shortly 🙏`,
    [{ id: `status_${taskId}`, title: '📋 Check Status' },
     { id: 'menu_main', title: '🏨 More Services' }],
    null,
    'Reply DONE ' + taskId + ' when served'
  );

  // Notify staff
  await wa.sendMessage(
    process.env.ADMIN_PHONE || '919816003322',
    `🔔 *NEW GUEST REQUEST*\n\n` +
    `ID: *${taskId}*\n` +
    `Room: *${guest.roomNumber}*\n` +
    `Guest: ${guest.guestName}\n` +
    `Service: *${service.split(': ').pop()}*\n` +
    `Dept: ${dept}\n` +
    `Time: ${new Date().toLocaleTimeString('en-IN')}\n\n` +
    `Reply *DONE ${taskId}* when completed.`
  );

  // Escalate to HOD after 5 min
  task.hodTimer = setTimeout(async () => {
    const t = activeTasks[taskId];
    if (!t || t.status === 'done') return;
    t.hodNotified = true;
    await wa.sendMessage(hodPhone,
      `⚠️ *PENDING — 5 MIN ELAPSED*\n\n` +
      `ID: *${taskId}*\n` +
      `Room: *${t.roomNumber}* | Guest: ${t.guestName}\n` +
      `Service: *${t.service.split(': ').pop()}*\n\n` +
      `Staff not completed yet!\n` +
      `Reply *DONE ${taskId}* when completed.`
    );
    // Escalate to Admin after 15 min
    t.adminTimer = setTimeout(async () => {
      const t2 = activeTasks[taskId];
      if (!t2 || t2.status === 'done') return;
      t2.adminNotified = true;
      await wa.sendMessage(process.env.ADMIN_PHONE || '919816003322',
        `🚨 *URGENT — 15 MIN ELAPSED*\n\n` +
        `ID: *${taskId}*\n` +
        `Room: *${t2.roomNumber}* | Guest: ${t2.guestName}\n` +
        `Service: *${t2.service.split(': ').pop()}*\n\n` +
        `🚨 HOD notified 10 min ago — still pending!\n` +
        `Reply *DONE ${taskId}* immediately.`
      );
    }, SERVICES_CONFIG.TASK_TIMEOUT_HOD - SERVICES_CONFIG.TASK_TIMEOUT_STAFF);
  }, SERVICES_CONFIG.TASK_TIMEOUT_STAFF);

  return taskId;
}

// ── COMPLETE TASK ─────────────────────────────────────────────────
async function completeTask(taskId, completedBy, wa) {
  const task = activeTasks[taskId];
  if (!task) return false;

  task.status = 'done';
  task.completedAt = new Date();
  const timeTaken = Math.round((task.completedAt - task.createdAt) / 60000);

  if (task.hodTimer) clearTimeout(task.hodTimer);
  if (task.adminTimer) clearTimeout(task.adminTimer);

  await wa.sendButtonMessage(
    task.phone,
    `✅ *Request Completed!*\n\nID: *${taskId}*\nService: ${task.service.split(': ').pop()}\nTime: ${timeTaken} min\n\nHope we could assist you well! 😊`,
    [{ id: 'menu_main', title: '🏨 More Services' },
     { id: 'menu_fb',   title: '⭐ Rate your stay' }]
  );

  await wa.sendMessage(
    process.env.ADMIN_PHONE || '919816003322',
    `✅ *TASK DONE*\n\nID: ${taskId} | Room ${task.roomNumber}\n` +
    `Service: ${task.service.split(': ').pop()}\n` +
    `Time: ${timeTaken} min ${timeTaken <= 5 ? '✅' : timeTaken <= 15 ? '⚠️' : '🚨'}`
  );

  // Store in task history
  if (!global.tasksHistory) global.tasksHistory = [];
  global.tasksHistory.unshift({
    id: taskId, roomNumber: task.roomNumber, guestName: task.guestName,
    dept: task.dept, service: task.service, status: 'done',
    timeTaken, completedBy, createdAt: task.createdAt,
    completedAt: task.completedAt
  });
  if (global.tasksHistory.length > 200) global.tasksHistory = global.tasksHistory.slice(0, 200);

  delete activeTasks[taskId];
  return true;
}

// ── FEEDBACK ──────────────────────────────────────────────────────
async function startFeedback(phone, guestName, wa) {
  feedbackSessions[phone] = { step: 'rating', guestName };
  await wa.sendRatingButtons(phone, guestName);
}

async function handleFeedback(phone, buttonId, text, wa) {
  const session = feedbackSessions[phone];
  if (!session) return false;

  const guest = guestRoomMap[phone] || { roomNumber: '?', guestName: session.guestName, hotelName: 'Hotel' };

  if (session.step === 'rating') {
    let rating = 0;
    if (buttonId === 'rating_5') rating = 5;
    else if (buttonId === 'rating_4') rating = 4;
    else if (buttonId === 'rating_low') rating = 2;
    else rating = parseInt(text) || 0;

    if (!rating || rating < 1 || rating > 5) {
      await wa.sendRatingButtons(phone, guest.guestName);
      return true;
    }

    session.rating = rating;
    const stars = '⭐'.repeat(Math.min(rating, 5));

    // Store in feedback history
    if (!global.feedbackHistory) global.feedbackHistory = [];
    global.feedbackHistory.unshift({
      phone, rating, roomNumber: guest.roomNumber,
      guestName: guest.guestName, reason: null,
      time: new Date().toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'})
    });
    if (global.feedbackHistory.length > 100) global.feedbackHistory = global.feedbackHistory.slice(0, 100);

    if (rating >= 4) {
      delete feedbackSessions[phone];
      await wa.sendMessage(phone,
        `${stars} Thank you for the *${rating}-star* rating!\n\n` +
        `We're so glad you enjoyed your stay! 🙏\n\n` +
        `Please share your experience on Google:\n\n` +
        `👇 *Leave a Google Review:*\n${SERVICES_CONFIG.GOOGLE_REVIEW_LINK}\n\n` +
        `It takes just 2 minutes and means a lot to us! 😊`
      );
      await wa.sendMessage(process.env.ADMIN_PHONE || '919816003322',
        `⭐ *POSITIVE FEEDBACK*\n\nRoom: ${guest.roomNumber} | Guest: ${guest.guestName}\nRating: ${stars} (${rating}/5)\nGoogle review link sent ✅`
      );
    } else {
      session.step = 'reason';
      await wa.sendMessage(phone,
        `${stars} Thank you for your honest feedback.\n\n` +
        `We're sorry your experience wasn't perfect. 🙏\n\n` +
        `Please tell us what we could do better:\n_(Type your feedback)_`
      );
    }
    return true;
  }

  if (session.step === 'reason') {
    const stars = '⭐'.repeat(session.rating);
    // Update reason in history
    if (global.feedbackHistory) {
      const entry = global.feedbackHistory.find(f => f.phone === phone);
      if (entry) entry.reason = text.trim();
    }
    delete feedbackSessions[phone];
    await wa.sendMessage(phone,
      `Thank you for sharing. 🙏\n\nYour feedback has been shared with our management.\nWe hope to serve you better next time!\n\nTeam ${guest.hotelName}`
    );
    await wa.sendMessage(process.env.ADMIN_PHONE || '919816003322',
      `⚠️ *NEGATIVE FEEDBACK*\n\nRoom: ${guest.roomNumber} | Guest: ${guest.guestName} (${phone})\nRating: ${stars} (${session.rating}/5)\n\n*Reason:* ${text}\n\n🚨 Please follow up immediately!`
    );
    return true;
  }

  return false;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────
// Call this from handleIncoming() BEFORE existing guest logic
async function handleGuestServices(phone, text, buttonId, wa) {
  const guest = guestRoomMap[phone];
  if (!guest) return false;

  const t = (text || '').trim().toUpperCase();

  // Handle feedback session (text replies)
  if (feedbackSessions[phone]) {
    return await handleFeedback(phone, buttonId, text, wa);
  }

  // Button interactions
  if (buttonId) {
    // Rating buttons
    if (['rating_5','rating_4','rating_low'].includes(buttonId)) {
      return await handleFeedback(phone, buttonId, text, wa);
    }
    // Main menu buttons
    if (buttonId === 'menu_main' || buttonId === 'menu_back') {
      await sendServiceMenu(phone, wa); return true;
    }
    if (buttonId === 'menu_hk') {
      await sendHousekeepingList(phone, wa); return true;
    }
    if (buttonId === 'menu_food') {
      await sendFoodList(phone, wa); return true;
    }
    if (buttonId === 'menu_more') {
      await sendMoreServicesMenu(phone, wa); return true;
    }
    if (buttonId === 'menu_mt') {
      await sendMaintenanceList(phone, wa); return true;
    }
    if (buttonId === 'menu_fd') {
      await sendFrontDeskList(phone, wa); return true;
    }
    if (buttonId === 'menu_ly') {
      await sendLaundryList(phone, wa); return true;
    }
    if (buttonId === 'menu_fb') {
      await startFeedback(phone, guest.guestName, wa); return true;
    }

    // Status button
    if (buttonId.startsWith('status_')) {
      const taskId = buttonId.replace('status_', '').toUpperCase();
      const task = activeTasks[taskId];
      if (task) {
        const elapsed = Math.round((new Date() - task.createdAt) / 60000);
        await wa.sendMessage(phone,
          `📋 *Task ${taskId}*\n\nService: ${task.service.split(': ').pop()}\nStatus: ⏳ In Progress\nElapsed: ${elapsed} min`
        );
      }
      return true;
    }

    // Service item selected from list
    if (ITEM_MAP[buttonId]) {
      const item = ITEM_MAP[buttonId];
      if (item.isCustom) {
        guestServiceSessions[phone] = { awaitingCustom: true, dept: item.dept };
        await wa.sendMessage(phone, `Please describe your request and we'll attend to you shortly:`);
      } else {
        await createTask(phone, item.dept, item.service, wa);
      }
      return true;
    }
  }

  // Text commands
  if (t === 'MENU' || t === '0' || t === 'HI' || t === 'HELLO' || t === 'HELP') {
    await sendServiceMenu(phone, wa); return true;
  }

  // DONE <taskId> from staff
  if (t.startsWith('DONE ')) {
    const taskId = t.split(/\s+/)[1];
    if (taskId && activeTasks[taskId]) {
      await completeTask(taskId, phone, wa); return true;
    }
  }

  // STATUS <taskId>
  if (t.startsWith('STATUS ')) {
    const taskId = t.split(/\s+/)[1];
    const task = activeTasks[taskId];
    if (task) {
      const elapsed = Math.round((new Date() - task.createdAt) / 60000);
      await wa.sendMessage(phone,
        `📋 *Task ${taskId}*\nService: ${task.service.split(': ').pop()}\nStatus: ⏳ In Progress\nElapsed: ${elapsed} min`
      );
      return true;
    }
  }

  // Custom request (free text after selecting "Other")
  if (guestServiceSessions[phone]?.awaitingCustom && text.length > 2) {
    const s = guestServiceSessions[phone];
    const dept = s.dept || 'frontdesk';
    const deptLabel = Object.values(DEPARTMENTS).find(d => d.dept === dept)?.label || '📞 Front Desk';
    const service = `${deptLabel}: ${text.trim()}`;
    delete guestServiceSessions[phone];
    await createTask(phone, dept, service, wa);
    return true;
  }

  return false;
}

module.exports = {
  registerGuestForServices,
  sendServiceMenu,
  handleGuestServices,
  startFeedback,
  completeTask,
  activeTasks,
  guestRoomMap,
  feedbackSessions,
  SERVICES_CONFIG,
};
