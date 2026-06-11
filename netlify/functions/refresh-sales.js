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

async function fetchNewSales(token, lastChecked) {
  // Convert lastChecked to Gmail query format
  const after = lastChecked ? Math.floor(new Date(lastChecked).getTime() / 1000) : Math.floor((Date.now() - 3 * 60 * 1000) / 1000);
  
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
    
    const subjectHeader = msg.payload?.headers?.find(h => h.name === 'Subject');
    const dateHeader = msg.payload?.headers?.find(h => h.name === 'Date');
    
    if (!subjectHeader) continue;
    
    const subject = subjectHeader.value;
    const orderMatch = subject.match(/Order#\s*(\d+)/i);
    const qtyMatch = subject.match(/sold\s+(\d+)\s+ticket/i);
    const eventMatch = subject.match(/ONLY\s+(.+?)\s+-\s+Order#/i);
    
    if (!orderMatch) continue;
    
    const date = dateHeader ? new Date(dateHeader.value) : new Date();
    const timeUTC = date.toISOString().slice(11, 16);
    
    sales.push({
      order: orderMatch[1],
      event: eventMatch ? eventMatch[1].trim() : 'Unknown Event',
      event_date: '',
      time: timeUTC,
      qty: qtyMatch ? parseInt(qtyMatch[1]) : 1,
      proc: ''
    });
  }
  
  return sales;
}

function assignSales(newSales, existingSales, schedules, priorityDays, priorityMembers) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const day = days[new Date().getDay()];
  
  const allProcessors = ['Kassandra','Lydia','Tochukwu','Joshua','Pearl','Enomfon','Lois','Marco','Christine'];
  const working = allProcessors.filter(p => schedules[p].includes(day));
  
  if (!working.length) return newSales.map((s, i) => ({ ...s, proc: 'Unassigned' }));
  
  const priorityActive = priorityDays.includes(day);
  const priorityWorkers = priorityMembers.filter(p => working.includes(p));
  const otherWorkers = working.filter(p => !priorityMembers.includes(p));
  
  // Sort by event date ascending
  const sorted = [...newSales].sort((a, b) => {
    if (!a.event_date && !b.event_date) return 0;
    if (!a.event_date) return 1;
    if (!b.event_date) return -1;
    return new Date(a.event_date) - new Date(b.event_date);
  });
  
  // Figure out current distribution to continue round-robin
  const existingCounts = {};
  working.forEach(p => { existingCounts[p] = existingSales.filter(s => s.proc === p).length; });
  
  let result = [];
  if (priorityActive && priorityWorkers.length) {
    const total = sorted.length;
    const priorityCount = Math.round(total * priorityWorkers.length / working.length);
    const prioritySales = sorted.slice(0, priorityCount);
    const otherSales = sorted.slice(priorityCount);
    
    prioritySales.forEach((s, i) => result.push({ ...s, proc: priorityWorkers[i % priorityWorkers.length] }));
    if (otherWorkers.length) {
      otherSales.forEach((s, i) => result.push({ ...s, proc: otherWorkers[i % otherWorkers.length] }));
    } else {
      otherSales.forEach((s, i) => result.push({ ...s, proc: priorityWorkers[i % priorityWorkers.length] }));
    }
  } else {
    sorted.forEach((s, i) => result.push({ ...s, proc: working[i % working.length] }));
  }
  
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
    'Pearl':     ['Tuesday','Wednesday','Thursday','Friday','Saturday'],
  };
  const PRIORITY_DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday'];
  const PRIORITY_MEMBERS = ['Joshua','Christine'];

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  // AUTO CHECK — called every 3 minutes by dashboard
  if (body.action === "check_new_sales") {
    try {
      const store = getStore("sales-dashboard");
      
      // Get existing sales and last checked time
      const existingData = await store.get("current-sales");
      const existingSales = existingData ? JSON.parse(existingData) : [];
      const metaData = await store.get("last-checked");
      const lastChecked = metaData ? JSON.parse(metaData).time : null;
      
      // Get Gmail token and fetch new sales
      const token = await getGmailToken();
      const newSales = await fetchNewSales(token, lastChecked);
      
      // Update last checked time
      await store.set("last-checked", JSON.stringify({ time: new Date().toISOString() }));
      
      if (newSales.length === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, newCount: 0, sales: existingSales }),
        };
      }
      
      // Filter out orders we already have
      const existingOrders = new Set(existingSales.map(s => s.order));
      const brandNewSales = newSales.filter(s => !existingOrders.has(s.order));
      
      if (brandNewSales.length === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, newCount: 0, sales: existingSales }),
        };
      }
      
      // Assign processors to new sales
      const assignedNewSales = assignSales(brandNewSales, existingSales, SCHEDULES, PRIORITY_DAYS, PRIORITY_MEMBERS);
      
      // Merge with existing and renumber
      const allSales = [...existingSales, ...assignedNewSales].map((s, i) => ({ ...s, n: i + 1 }));
      
      // Save back to store
      await store.set("current-sales", JSON.stringify(allSales));
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, newCount: brandNewSales.length, sales: allSales }),
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: err.message, sales: [] }),
      };
    }
  }

  // SAVE sales to Netlify Blobs
  if (body.action === "save_sales") {
    try {
      const store = getStore("sales-dashboard");
      await store.set("current-sales", JSON.stringify(body.sales));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: "Sales saved successfully", count: body.sales.length }),
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: "Failed to save: " + err.message }),
      };
    }
  }

  // LOAD sales from Netlify Blobs
  if (body.action === "load_sales") {
    try {
      const store = getStore("sales-dashboard");
      const data = await store.get("current-sales");
      if (!data) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, sales: [], empty: true }),
        };
      }
      const sales = JSON.parse(data);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, sales, count: sales.length }),
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: "Failed to load: " + err.message, sales: [] }),
      };
    }
  }

  // CLEAR sales from Netlify Blobs
  if (body.action === "clear_sales") {
    try {
      const store = getStore("sales-dashboard");
      await store.delete("current-sales");
      await store.delete("last-checked");
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: "Sales cleared" }),
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: false, error: "Failed to clear: " + err.message }),
      };
    }
  }

  // READ email action
  if (body.action === "read_email") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: `Order ${body.order} accepted.` }),
    };
  }

  // Default: handle AI prompt
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
  }

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
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Failed to reach Anthropic API", detail: err.message }),
    };
  }
};
