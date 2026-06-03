exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  // Handle email reading action
  if (body.action === 'read_email') {
    const order = body.order;
    if (!order) {
      return { statusCode: 400, body: JSON.stringify({ error: "No order provided" }) };
    }

    const gmailToken = process.env.GMAIL_TOKEN;
    if (!gmailToken) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true, message: `Order ${order} accepted.` }),
      };
    }

    try {
      const searchRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=subject:${order}`,
        { headers: { Authorization: `Bearer ${gmailToken}` } }
      );
      const searchData = await searchRes.json();

      if (searchData.messages && searchData.messages.length > 0) {
        const msgId = searchData.messages[0].id;
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${gmailToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
          }
        );
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true, message: `Order ${order} accepted and email marked as read.` }),
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success: true, message: `Order ${order} accepted.` }),
      };
    }
  }

  // Default: handle AI prompt
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Failed to reach Anthropic API", detail: err.message }),
    };
  }
};
