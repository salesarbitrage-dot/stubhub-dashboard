const { getStore } = require("@netlify/blobs");

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
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
