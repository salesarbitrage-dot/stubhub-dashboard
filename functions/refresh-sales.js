const { getStore } = require("@netlify/blobs");

async function getGmailToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  return data.access_token;
}

function getTodayKey() {
  const now = new Date();
  const chicago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return `${chicago.getFullYear()}-${String(chicago.getMonth()+1).padStart(2,'0')}-${String(chicago.getDate()).padStart(2,'0')}`;
}

function extractEventDate(text) {
  const patterns = [
    /upload them by \w+,\s+(\d+\s+\w+\s+\d{4})/i,
    /transfer them by \w+,\s+(\d+\s+\w+\s+\d{4})/i,
    /by \w+,\s+(\d+\s+\w+\s+\d{4})/i,
    /(\d{1,2}\s+\w+\s+\d{4})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const d = new Date(match[1]);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return '';
}

function getChicagoInfo() {
  const now = new Date();
  const chicago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const currentMinutes = chicago.getHours() * 60 + chicago.getMinutes();
  const todayName = days[chicago.getDay()];
  const tomorrowName = days[(chicago.getDay() + 1) % 7];
  return { currentMinutes, todayName, tomorrowName };
}

function isOnShift(processor, currentMinutes) {
  const SHIFTS = {
    'Kassandra': { in: 7*60+30,  out: 15*60 },
    'Lydia':     { in: 4*60+30,  out: 12*60 },
    'Tochukwu':  { in: 9*60+30,  out: 17*60 },
    'Joshua':    { in: 4*60+30,  out: 12*60 },
    'Enomfon':   { in: 12*60+30, out: 20*60 },
    'Lois':      { in: 12*60+30, out: 20*60 },
    'Marco':     { in: 7*60+30,  out: 15*60 },
    'Christine': { in: 4*60+30,  out: 12*60 },
  };
  const shift = SHIFTS[processor];
  if (!shift) return false;
  return currentMinutes >= shift.in && currentMinutes < shift.out;
}

async function fetchNewSales(token, lastChecked) {
  const now = new Date();
  const chicago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  chicago.setHours(0, 0, 0, 0);
  const after = lastChecked
    ? Math.floor(new Date(lastChecked).getTime() / 1000)
    : Math.floor(chicago.getTime() / 1000);

  const query = encodeURIComponent(`label:SOLD-STUBHUB-TICKETS after:${after}`);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${query}&maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!data.threads || data.threads.length === 0) return [];

  const sales = [];
  for (const thread of data.threads) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${thread.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const msg = await msgRes.json();
    const headers = msg.payload?.headers || [];
    const subjectHeader = headers.find(h => h.name === 'Subject');
    const dateHeader = headers.find(h => h.name === 'Date');
    if (!subjectHeader) continue;
    const subject = subjectHeader.value;
    const orderMatch = subject.match(/Order#\s*(\d+)/i);
    const qtyMatch = subject.match(/sold\s+(\d+)\s+ticket/i);
    const eventMatch = subject.match(/ONLY\s+(.+?)\s+-\s+Order#/i);
    if (!orderMatch) continue;
    const snippet = (msg.snippet || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    const date = dateHeader ? new Date(dateHeader.value) : new Date();
    const timeUTC = date.toISOString().slice(11, 16);
    const eventDate = extractEventDate(snippet);
    sales.push({
      order: orderMatch[1],
      event: eventMatch ? eventMatch[1].trim() : 'Unknown Event',
      event_date: eventDate,
      time: timeUTC,
      qty: qtyMatch ? parseInt(qtyMatch[1]) : 1,
      proc: ''
    });
  }
  return sales;
}

function assignSales(newSales, existingSales, schedules, priorityDays, priorityMembers) {
  const { currentMinutes, todayName, tomorrowName } = getChicagoInfo();
  const allProcessors = ['Kassandra','Lydia','Tochukwu','Joshua','Enomfon','Lois','Marco','Christine'];

  const SHIFTS = {
    'Kassandra': { in: 7*60+30,  out: 15*60 },
    'Lydia':     { in: 4*60+30,  out: 12*60 },
    'Tochukwu':  { in: 9*60+30,  out: 17*60 },
    'Joshua':    { in: 4*60+30,  out: 12*60 },
    'Enomfon':   { in: 12*60+30, out: 20*60 },
    'Lois':      { in: 12*60+30, out: 20*60 },
    'Marco':     { in: 7*60+30,  out: 15*60 },
    'Christine': { in: 4*60+30,  out: 12*60 },
  };

  // After 8 PM (20:00) → assign to tomorrow's workers
  const isAfter8PM = currentMinutes >= 20 * 60;

  let activeWorkers;

  if (isAfter8PM) {
    // Get tomorrow's scheduled workers sorted by clock-in time (earliest first)
    const tomorrowWorkers = allProcessors.filter(p => schedules[p].includes(tomorrowName));
    // Sort by earliest clock-in time so first shift workers are prioritized
    tomorrowWorkers.sort((a, b) => (SHIFTS[a]?.in || 0) - (SHIFTS[b]?.in || 0));
    activeWorkers = tomorrowWorkers;
  } else {
    // Normal logic — use current on-shift workers
    const todayWorkers = allProcessors.filter(p => schedules[p].includes(todayName));
    const onShift = todayWorkers.filter(p => isOnShift(p, currentMinutes));
    activeWorkers = onShift.length > 0 ? onShift : todayWorkers;
  }

  if (!activeWorkers.length) return newSales.map((s) => ({ ...s, proc: 'Unassigned' }));

  const day = isAfter8PM ? tomorrowName : todayName;
  const priorityActive = priorityDays.includes(day);
  const priorityWorkers = priorityMembers.filter(p => activeWorkers.includes(p));
  const otherWorkers = activeWorkers.filter(p => !priorityMembers.includes(p));

  // Build workload counter
  const workload = {};
  activeWorkers.forEach(p => { workload[p] = 0; });
  existingSales.forEach(s => {
    if (s.proc && workload[s.proc] !== undefined) workload[s.proc]++;
  });

  function getLeastLoaded(group) {
    return group.reduce((min, p) => workload[p] < workload[min] ? p : min, group[0]);
  }

  // Same event → same processor
  const eventProcMap = {};
  existingSales.forEach(s => {
    if (s.event && s.proc) {
      const key = s.event.toLowerCase().trim();
      if (!eventProcMap[key]) eventProcMap[key] = s.proc;
    }
  });

  const unassigned = [];
  const result = [];
  newSales.forEach(s => {
    const key = s.event.toLowerCase().trim();
    if (eventProcMap[key] && activeWorkers.includes(eventProcMap[key])) {
      const proc = eventProcMap[key];
      result.push({ ...s, proc });
      workload[proc] = (workload[proc] || 0) + 1;
    } else {
      unassigned.push(s);
    }
  });

  const withDates = unassigned.filter(s => s.event_date && s.event_date.trim() !== '');
  const withoutDates = unassigned.filter(s => !s.event_date || s.event_date.trim() === '');

  if (priorityActive && priorityWorkers.length && withDates.length > 0) {
    const sorted = [...withDates].sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
    const priorityCount = Math.round(sorted.length * priorityWorkers.length / activeWorkers.length);
    sorted.slice(0, priorityCount).forEach(s => {
      const proc = getLeastLoaded(priorityWorkers);
      result.push({ ...s, proc }); workload[proc]++;
    });
    const fallback = otherWorkers.length ? otherWorkers : activeWorkers;
    sorted.slice(priorityCount).forEach(s => {
      const proc = getLeastLoaded(fallback);
      result.push({ ...s, proc }); workload[proc]++;
    });
  } else {
    withDates.forEach(s => {
      const proc = getLeastLoaded(activeWorkers);
      result.push({ ...s, proc }); workload[proc]++;
    });
  }

  withoutDates.forEach(s => {
    const proc = getLeastLoaded(activeWorkers);
    result.push({ ...s, proc }); workload[proc]++;
  });

  return result;
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const SCHEDULES = {
    'Enomfon':   ['Monday','Tuesday','Thursday','Friday','Saturday'],
    'Christine': ['Monday','Tuesday','Wednesday','Thursday','Saturday'],
    'Lois':      ['Monday','Tuesday','Wednesday','Thursday','Saturday'],
    'Tochukwu':  ['Monday','Tuesday','Wednesday','Thursday','Sunday'],
    'Joshua':    ['Monday','Tuesday','Wednesday','Thursday','Sunday'],
    'Marco':     ['Tuesday','Wednesday','Thursday','Friday','Saturday'],
    'Kassandra': ['Monday','Tuesday','Friday','Saturday','Sunday'],
    'Lydia':     ['Monday','Tuesday','Wednesday','Thursday','Sunday'],
  };
  const PRIORITY_DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];
  const PRIORITY_MEMBERS = ['Joshua','Christine'];

  const siteID = process.env.NETLIFY_SITE_ID;
  const netlifyToken = process.env.NETLIFY_TOKEN;

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (body.action === "check_new_sales") {
    try {
      const today = getTodayKey();
      const store = getStore({ name: "sales-dashboard", siteID, token: netlifyToken });
      const existingData = await store.get(`sales-${today}`);
      let existingActive = [];
      let existingProcessed = [];
      if (existingData) {
        const parsed = JSON.parse(existingData);
        if (Array.isArray(parsed)) {
          existingActive = parsed;
        } else {
          existingActive = parsed.active || [];
          existingProcessed = parsed.processed || [];
        }
      }
      const metaData = await store.get(`last-checked-${today}`);
      const lastChecked = metaData ? JSON.parse(metaData).time : null;
      const gmailToken = await getGmailToken();
      const newSales = await fetchNewSales(gmailToken, lastChecked);
      await store.set(`last-checked-${today}`, JSON.stringify({ time: new Date().toISOString() }));
      if (newSales.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, newCount: 0, sales: { active: existingActive, processed: existingProcessed } }) };
      }
      const existingOrders = new Set([...existingActive, ...existingProcessed].map(s => s.order));
      const brandNewSales = newSales.filter(s => !existingOrders.has(s.order));
      if (brandNewSales.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, newCount: 0, sales: { active: existingActive, processed: existingProcessed } }) };
      }
      const assignedNewSales = assignSales(brandNewSales, existingActive, SCHEDULES, PRIORITY_DAYS, PRIORITY_MEMBERS);
      const allActive = [...existingActive, ...assignedNewSales].map((s, i) => ({ ...s, n: i + 1 }));
      await store.set(`sales-${today}`, JSON.stringify({ active: allActive, processed: existingProcessed }));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, newCount: brandNewSales.length, sales: { active: allActive, processed: existingProcessed } }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message, sales: { active: [], processed: [] } }) };
    }
  }

  if (body.action === "save_sales") {
    try {
      const today = body.date || getTodayKey();
      const store = getStore({ name: "sales-dashboard", siteID, token: netlifyToken });
      await store.set(`sales-${today}`, JSON.stringify(body.sales));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
  }

  if (body.action === "load_sales") {
    try {
      const dateKey = body.date || getTodayKey();
      const store = getStore({ name: "sales-dashboard", siteID, token: netlifyToken });
      const data = await store.get(`sales-${dateKey}`);
      if (!data) return { statusCode: 200, headers, body: JSON.stringify({ success: true, sales: { active: [], processed: [] }, empty: true }) };
      const parsed = JSON.parse(data);
      const sales = Array.isArray(parsed) ? { active: parsed, processed: [] } : parsed;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, sales, date: dateKey }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message, sales: { active: [], processed: [] } }) };
    }
  }

  if (body.action === "list_dates") {
    try {
      const store = getStore({ name: "sales-dashboard", siteID, token: netlifyToken });
      const { blobs } = await store.list({ prefix: "sales-" });
      const dates = blobs
        .map(b => b.key.replace("sales-", ""))
        .filter(d => d.match(/^\d{4}-\d{2}-\d{2}$/))
        .sort().reverse();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, dates }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, dates: [] }) };
    }
  }

  if (body.action === "clear_sales") {
    try {
      const today = body.date || getTodayKey();
      const store = getStore({ name: "sales-dashboard", siteID, token: netlifyToken });
      await store.delete(`sales-${today}`);
      await store.delete(`last-checked-${today}`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
  }

  if (body.action === "read_email") {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: `Order ${body.order} accepted.` }) };
  }

  if (body.action === "debug_email") {
    try {
      const gmailToken = await getGmailToken();
      const query = encodeURIComponent(`label:SOLD-STUBHUB-TICKETS`);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${query}&maxResults=1`,
        { headers: { Authorization: `Bearer ${gmailToken}` } }
      );
      const data = await res.json();
      if (!data.threads || !data.threads[0]) return { statusCode: 200, headers, body: JSON.stringify({ error: "No threads found" }) };
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.threads[0].id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${gmailToken}` } }
      );
      const msg = await msgRes.json();
      const snippet = (msg.snippet || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      return { statusCode: 200, headers, body: JSON.stringify({ snippet, extractedDate: extractEventDate(snippet), subject: msg.payload?.headers?.find(h => h.name === 'Subject')?.value }) };
    } catch(err) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: "You are a data assistant. Return ONLY a valid JSON array, no markdown fences, no explanation. Each object must have: {order, event, event_date, time, qty, proc}.",
        messages: [{ role: "user", content: body.prompt }],
      }),
    });
    const data = await response.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to reach Anthropic API", detail: err.message }) };
  }
};
