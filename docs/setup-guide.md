# Cloudflare Worker - PORTFOLIO-CHAT-WORKER  setup

Working path for **GitHub Pages + Cloudflare Worker**.


## TL;DR

```bash
npm install -g wrangler
wrangler login
npm create cloudflare@latest portfolio-chat-worker
cd portfolio-chat-worker

# add secret key
wrangler secret put OPENAI_API_KEY
# test locally
wrangler dev
# deploy worker
wrangler deploy
```

Deployed worker:
> https://portfolio-chat-worker.cordovan-edu.workers.dev

---

## What you are building

You will keep your portfolio site on GitHub Pages.

You will add **one tiny Cloudflare Worker** that exposes:

```text
POST /api/chat
```

Your browser chat widget will call that Worker. The Worker will hold the real OpenAI key as a **Cloudflare secret**, which Cloudflare says should be used for sensitive data like API tokens because secret values are not visible after you define them. 

---

## Step 1: Create a Cloudflare account and install Wrangler

Cloudflare Workers are deployed with **Wrangler**, Cloudflare’s CLI. Their current getting-started flow is to create a new Worker project from the CLI, choosing **Hello World**, **Worker only**, and **JavaScript**. 

Run:

```bash
npm install -g wrangler
wrangler login
```

Then create the Worker project:

```bash
npm create cloudflare@latest portfolio-chat-worker
```

When prompted, choose:

* **Hello World example**
* **Worker only**
* **JavaScript**
* **Yes** for git
* **No** for deploy right away

That matches Cloudflare’s current quickstart.


Then move into the folder:

```bash
cd portfolio-chat-worker
```

---

## Step 2: Replace the Worker code with this minimal proxy

Open the generated Worker entry file and replace it with this.

For many new Worker projects, that file is `src/index.js`.

```js
export default {
  async fetch(request, env) {
    const allowedOrigin = "https://cordovank.github.io";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(allowedOrigin),
      });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, allowedOrigin);
    }

    try {
      const body = await request.json();
      const messages = body.messages;

      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: "Missing messages array" }, 400, allowedOrigin);
      }

      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 400,
        }),
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        return json(
          { error: "Upstream OpenAI error", details: data },
          upstream.status,
          allowedOrigin
        );
      }

      const answer = data.choices?.[0]?.message?.content ?? "No response.";
      return json({ answer }, 200, allowedOrigin);
    } catch (err) {
      return json(
        { error: "Worker error", details: String(err) },
        500,
        allowedOrigin
      );
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}
```

Why this shape:

* Cloudflare Workers receive HTTP requests in a `fetch()` handler and return a `Response`.
* CORS headers are needed because your GitHub Pages site and Worker are different origins, and Cloudflare documents using a Worker to set CORS headers for cross-origin requests.

---

## Step 3: Add your OpenAI API key as a Cloudflare secret

Do **not** put the key in the code.

### Deployed secret 

Run in bash `wrangler secret put` to create a deployed secret, but local dev uses local secret files.

Cloudflare’s docs say secrets are environment variables whose values are not visible after you define them, and sensitive values like API tokens should be stored as secrets rather than plain vars. 

### Local

Secrets must come from a `.dev.vars` or `.env` file in the Worker project directory; 

Steps:
1. Create a file named `.dev.vars`
2. Put this inside:

    ```dotenv
    OPENAI_API_KEY="your_real_openai_key_here"
    ```

3. Make sure `.dev.vars` is in `.gitignore`


The setup is now:

* **local testing**: `.dev.vars`
* **deployed worker**: `wrangler secret put OPENAI_API_KEY` (Paste your real OpenAI API key when prompted.)

To verify quickly, add this temporary line near the top of `fetch()`:

```js
console.log("Has key?", !!env.OPENAI_API_KEY);
```

It should print `true` locally after you add `.dev.vars`.

---

## Step 4: Test it locally

Run:

```bash
wrangler dev
```

Cloudflare’s docs support local development for Workers, and local secrets can be handled with `.dev.vars` or `.env` files for development, but for your first pass, using `wrangler secret put` for deployed secrets is enough.

You should get a local URL.

Test with curl:

```bash
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "system", "content": "You are a helpful portfolio assistant." },
      { "role": "user", "content": "Say hello in one sentence." }
    ]
  }'
```

If that works, the Worker is good.

---

## Step 5: Deploy the Worker

Run:

```bash
wrangler deploy

# Output:

# Total Upload: 8.76 KiB / gzip: 2.49 KiB
# Worker Startup Time: 6 ms

# Deployed portfolio-chat-worker triggers (2.26 sec)
#   https://portfolio-chat-worker.cordovan-edu.workers.dev
# Current Version ID: cfbbc7d6-a526-4760-b656-bdffc33355eb
```


Cloudflare Workers are deployed with a single command, and the platform is designed for deploying code without managing infrastructure yourself.

After deploy, Cloudflare will give you a URL that looks like:

```text
https://portfolio-chat-worker.<your-subdomain>.workers.dev
```

Your endpoint will be:

```text
https://portfolio-chat-worker.<your-subdomain>.workers.dev
```

since this Worker handles the root request directly.

---

## Step 6: Change your GitHub Pages widget to call the Worker

Remove this completely:

```js
const API_KEY = 'YOUR_API_KEY_HERE';
```

Then replace your OpenAI call with this:

```js
async function callOpenAI() {
  const messages = [
    { role: 'system', content: PORTFOLIO_KNOWLEDGE },
    ...conversationHistory,
  ];

  const response = await fetch(
    'https://portfolio-chat-worker.YOUR_SUBDOMAIN.workers.dev',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Worker ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.answer;
}
```

Now your site sends the chat request to your Worker, and the Worker sends it to OpenAI using the secret.

That is the whole security fix.

---

## Step 7: Push your GitHub Pages update

Commit the changed frontend JS and publish as normal.

Your GitHub Pages site remains static. The only difference is that chat requests now go to Cloudflare instead of OpenAI directly.

---

## Step 8: Add two small protections immediately

Before you go live, keep these two safeguards:

First, keep this exact origin allowlist in the Worker:

```js
const allowedOrigin = "https://cordovank.github.io";
```

That limits browser access to your site’s origin via CORS. CORS is specifically how browsers decide whether a page from one origin may call a different origin.

Second, keep your model cheap and your output small:

```js
model: "gpt-4o-mini",
max_tokens: 400
```

That reduces cost exposure if the widget gets unexpected usage.

---

## Your simplest folder split

You now have two tiny projects:

### 1. GitHub Pages portfolio

Contains:

* HTML/CSS/JS
* widget UI
* `PORTFOLIO_KNOWLEDGE`

### 2. Cloudflare Worker

Contains:

* one `fetch()` handler
* one secret: `OPENAI_API_KEY`

That is all.

---

## What you should expect to see

After this change:

* visitors can still use your chat widget
* they cannot see your OpenAI key in the browser
* your Worker becomes the secure middle layer
* you keep GitHub Pages

---

## One important limitation

This is the **simplest** version, not the most hardened one.

It protects the key correctly, but it does **not yet** include:

* rate limiting
* abuse protection
* request validation beyond basics
* logging
* streaming responses
* domain verification beyond browser CORS behavior

CORS helps with browser access, but it is not a full authentication system by itself. For a portfolio widget, that is often acceptable as a first version, but it is worth knowing.

---

## Exact next action

Do these in order:

```bash
npm install -g wrangler
wrangler login
npm create cloudflare@latest portfolio-chat-worker
cd portfolio-chat-worker
```

Replace the Worker code with the version above, then run:

```bash
wrangler secret put OPENAI_API_KEY
wrangler dev
wrangler deploy
```

Then update your portfolio JS to call the Worker URL instead of OpenAI directly.

I can give you the **exact file-by-file version** next, including what `src/index.js` and your updated `portfolio-chat.js` should look like end to end.

[1]: https://developers.cloudflare.com/workers/configuration/environment-variables/?utm_source=chatgpt.com "Environment variables - Workers"
[2]: https://developers.cloudflare.com/workers/get-started/guide/?utm_source=chatgpt.com "Get started - CLI · Cloudflare Workers docs"
[3]: https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/?utm_source=chatgpt.com "Fetch Handler - Workers"
[4]: https://developers.cloudflare.com/workers/examples/cors-header-proxy/?utm_source=chatgpt.com "CORS header proxy · Cloudflare Workers docs"
[5]: https://developers.cloudflare.com/workers/development-testing/environment-variables/?utm_source=chatgpt.com "Environment variables and secrets - Workers"
[6]: https://developers.cloudflare.com/workers/?utm_source=chatgpt.com "Overview · Cloudflare Workers docs"
[7]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/?utm_source=chatgpt.com "CORS · Cloudflare One docs"
