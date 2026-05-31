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
        system:
          "You are a data assistant. Return ONLY a valid JSON array, no markdown fences, no explanation. Each object must have: {order, event, venue, time, qty, proc} where proc is one of: Kassandra, Lydia, Tochukwu, Joshua. Assignment rules: Kassandra=World Cup matches, Tochukwu=sports (MLB/NHL/MLS/NCAA/NFL), Joshua=multi-day festivals, Lydia=all other concerts and single-day shows.",
        messages: [
          {
            role: "user",
            content: body.prompt,
          },
        ],
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Failed to reach Anthropic API", detail: err.message }),
    };
  }
};