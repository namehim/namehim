var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var CACHE_KEY = "reports_cache";
var REFRESH_LOCK_KEY = "reports_refreshing";
var LAST_SUCCESS_KEY = "reports_last_success";

// US state names set – used for counting reports per state
const US_STATES_SET = new Set([
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky',
  'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico',
  'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://namehim.app",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/version") {
      return new Response(JSON.stringify({
        commit: env.COMMIT_HASH || "unknown",
        deployed_at: env.DEPLOYED_AT || "unknown"
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 🚀 GET /reports – paginated reports
    if (request.method === "GET" && url.pathname === "/reports") {
      const page = parseInt(url.searchParams.get("page")) || 1;
      const limit = parseInt(url.searchParams.get("limit")) || 50;
      const offset = (page - 1) * limit;

      let cached = null;
      try {
        if (env.CACHE_KV) cached = await env.CACHE_KV.get(CACHE_KEY, "json");
      } catch (e) { console.error("KV read error:", e); }
      
      let reports;
      if (cached && Array.isArray(cached)) {
        reports = cached;
        ctx.waitUntil(refreshIfStale(env));
      } else {
        reports = await fetchAllReports(env);
        if (reports && reports.length && env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
      }
      
      if (!reports) {
        return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: corsHeaders() });
      }
      
      const total = reports.length;
      const paginatedReports = reports.slice(offset, offset + limit);
      
      return new Response(JSON.stringify({
        total,
        page,
        limit,
        reports: paginatedReports
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // 🆕 GET /stats – aggregated counts for maps (fast, uses cached reports)
    if (request.method === "GET" && url.pathname === "/stats") {
      let cached = null;
      try {
        if (env.CACHE_KV) cached = await env.CACHE_KV.get(CACHE_KEY, "json");
      } catch (e) { console.error("KV read error:", e); }
      
      let reports;
      if (cached && Array.isArray(cached)) {
        reports = cached;
        ctx.waitUntil(refreshIfStale(env));
      } else {
        reports = await fetchAllReports(env);
        if (reports && reports.length && env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
      }
      
      if (!reports) {
        return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: corsHeaders() });
      }
      
      // Count reports per state (US only) and per country
      const stateCounts = {};
      const countryCounts = {};
      
      for (const r of reports) {
        // Country counts
        const country = r.country;
        if (country) {
          countryCounts[country] = (countryCounts[country] || 0) + 1;
        }
        // State counts (only if state is one of the US states)
        const state = r.state;
        if (state && US_STATES_SET.has(state)) {
          stateCounts[state] = (stateCounts[state] || 0) + 1;
        }
      }
      
      return new Response(JSON.stringify({
        total: reports.length,
        stateCounts,
        countryCounts
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmitReport(request, env);
    }
    if (request.method === "POST" && url.pathname === "/submit-story") {
      return handleSubmitStory(request, env);
    }

    // ----- GET /filtered-reports (or root)  (full list, legacy) -----
    let cached = null;
    try {
      if (env.CACHE_KV) {
        cached = await env.CACHE_KV.get(CACHE_KEY, "json");
      }
    } catch (e) {
      console.error("KV read error:", e);
    }

    if (cached && Array.isArray(cached)) {
      ctx.waitUntil(refreshIfStale(env));
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://namehim.app",
          "Cache-Control": "public, max-age=60"
        }
      });
    }

    try {
      const reports = await fetchAllReports(env);
      if (reports && reports.length) {
        if (env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
        return new Response(JSON.stringify(reports), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://namehim.app"
          }
        });
      }
    } catch (err) {
      console.error("Initial fetch failed:", err);
    }

    return new Response(JSON.stringify({ error: "Service temporarily unavailable. Please try again in a minute." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://namehim.app" }
    });
  }
};

async function handleSubmitReport(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return errorResponse("Invalid JSON", 400);
  }

  if (!payload.name || !payload.city || !payload.country || !payload.categories) {
    return errorResponse("Missing required fields", 400);
  }

  const token = payload.turnstileToken;
  if (!token) return errorResponse("CAPTCHA token missing", 400);

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) return errorResponse("Invalid CAPTCHA", 400);

  const { turnstileToken, ...reportData } = payload;
  const insertRes = await supabaseFetch(supabaseUrl, supabaseKey, "/rest/v1/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reportData)
  });
  if (!insertRes.ok) {
    console.error(await insertRes.text());
    return errorResponse("Submission failed", 500);
  }

  if (env.CACHE_KV) {
    await env.CACHE_KV.delete(CACHE_KEY);
    await env.CACHE_KV.delete(LAST_SUCCESS_KEY);
  }
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders() });
}
__name(handleSubmitReport, "handleSubmitReport");

async function handleSubmitStory(request, env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return errorResponse("Invalid JSON", 400);
  }

  const { title, content, submitter_uuid, turnstileToken } = payload;
  if (!content || typeof content !== "string") {
    return errorResponse("Missing story content", 400);
  }
  if (content.length > 1000) return errorResponse("Story too long", 400);
  if (!turnstileToken) return errorResponse("CAPTCHA token missing", 400);

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) return errorResponse("Invalid CAPTCHA", 400);

  const insertRes = await supabaseFetch(supabaseUrl, supabaseKey, "/rest/v1/stories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: title || null,
      content,
      submitter_uuid: submitter_uuid || null,
      is_approved: false
    })
  });
  if (!insertRes.ok) {
    console.error(await insertRes.text());
    return errorResponse("Submission failed", 500);
  }
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders() });
}
__name(handleSubmitStory, "handleSubmitStory");

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://namehim.app"
  };
}
__name(corsHeaders, "corsHeaders");

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: corsHeaders() });
}
__name(errorResponse, "errorResponse");

async function refreshIfStale(env) {
  if (!env.CACHE_KV) return;
  const lastSuccess = await env.CACHE_KV.get(LAST_SUCCESS_KEY);
  const now = Date.now();
  if (lastSuccess && now - parseInt(lastSuccess) < 300000) return; // 5 min

  const lock = await env.CACHE_KV.get(REFRESH_LOCK_KEY);
  if (lock) return;
  await env.CACHE_KV.put(REFRESH_LOCK_KEY, "1", { expirationTtl: 60 });
  try {
    const reports = await fetchAllReports(env);
    if (reports && reports.length) {
      await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
      await env.CACHE_KV.put(LAST_SUCCESS_KEY, now.toString());
    }
  } catch (err) {
    console.error("Background refresh failed:", err);
  } finally {
    await env.CACHE_KV.delete(REFRESH_LOCK_KEY);
  }
}
__name(refreshIfStale, "refreshIfStale");

async function supabaseFetch(supabaseUrl, supabaseKey, relativeUrl, options = {}) {
  const fullUrl = `${supabaseUrl}${relativeUrl}`;
  const fetchOptions = {
    ...options,
    headers: {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      ...options.headers
    },
    cf: { resolveOverride: "cmmggaprguusffiphegy.supabase.co" }
  };
  return fetch(fullUrl, fetchOptions);
}
__name(supabaseFetch, "supabaseFetch");

async function fetchAllReports(env) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const batchSize = 1000;
  let allReports = [];
  let offset = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 2;
  const TIMEOUT_MS = 60000;

  const blockRes = await supabaseFetch(supabaseUrl, supabaseKey, "/rest/v1/blocked_names?select=name");
  let blockedSet = new Set();
  if (blockRes.ok) {
    const blockedNames = await blockRes.json();
    blockedSet = new Set(blockedNames.map(b => b.name.toLowerCase()));
  } else {
    console.error("Failed to fetch blocklist");
  }

  while (true) {
    const url = `${supabaseUrl}/rest/v1/reports?select=id,name,city,state,country,categories,created_at&order=created_at.desc&limit=${batchSize}&offset=${offset}`;
    let batch = null;
    let success = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(url, {
          headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
          signal: controller.signal,
          cf: { resolveOverride: "cmmggaprguusffiphegy.supabase.co" }
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        batch = await res.json();
        success = true;
        break;
      } catch (err) {
        console.error(`Batch offset ${offset} attempt ${i+1} failed:`, err);
        if (i === MAX_ATTEMPTS - 1) return null;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!success || !batch.length) break;

    const isCleanReport = (r) => {
      if (blockedSet.has(r.name.toLowerCase())) return false;
      const cats = r.categories || [];
      if (!Array.isArray(cats) || cats.length > 8) return false;
      if (cats.some(c => typeof c !== "string" || c.length > 100 || /[<>]|javascript:/i.test(c))) return false;
      if (JSON.stringify(r).length > 5000) return false;
      return true;
    };
    const cleanedBatch = batch.filter(isCleanReport);
    allReports = allReports.concat(cleanedBatch);

    if (batch.length < batchSize) break;
    offset += batchSize;
  }
  return allReports;
}
__name(fetchAllReports, "fetchAllReports");
