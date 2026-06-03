var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var CACHE_KEY = "reports_cache";
var REFRESH_LOCK_KEY = "reports_refreshing";
var LAST_SUCCESS_KEY = "reports_last_success";
var BLOCKED_NAMES_KEY = "blocked_names_cache";

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
      const sortBy = normalizeSortBy(url.searchParams.get("sortBy"));
      const sortDirection = normalizeSortDirection(url.searchParams.get("sortDirection"));
      const category = normalizeCategoryFilter(url.searchParams.get("category"));

      let cached = null;
      try {
        if (env.CACHE_KV) cached = await env.CACHE_KV.get(CACHE_KEY, "json");
      } catch (e) { console.error("KV read error:", e); }
      
      let reports;
      if (cached && Array.isArray(cached)) {
        reports = cached;
        ctx.waitUntil(refreshIfStale(env));
      } else {
        reports = await fetchAllReportsFromD1(env);
        if (reports && reports.length && env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
      }
      
      if (!reports) {
        return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: corsHeaders() });
      }
      
      const preparedReports = sortAndFilterReports(reports, { sortBy, sortDirection, category });
      const total = preparedReports.length;
      const offset = (page - 1) * limit;
      const paginatedReports = preparedReports.slice(offset, offset + limit);
      
      return new Response(JSON.stringify({
        total,
        page,
        limit,
        sortBy,
        sortDirection,
        category,
        reports: paginatedReports
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // GET /stats – aggregated counts for maps
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
        reports = await fetchAllReportsFromD1(env);
        if (reports && reports.length && env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
      }
      
      if (!reports) {
        return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: corsHeaders() });
      }
      
      const stateCounts = {};
      const countryCounts = {};
      
      for (const r of reports) {
        const country = r.country;
        if (country) countryCounts[country] = (countryCounts[country] || 0) + 1;
        const state = r.state;
        if (state && US_STATES_SET.has(state)) stateCounts[state] = (stateCounts[state] || 0) + 1;
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

    // ----- GET /filtered-reports (full list, legacy) -----
    let cached = null;
    try {
      if (env.CACHE_KV) cached = await env.CACHE_KV.get(CACHE_KEY, "json");
    } catch (e) { console.error("KV read error:", e); }

    if (cached && Array.isArray(cached)) {
      ctx.waitUntil(refreshIfStale(env));
      const preparedReports = sortAndFilterReports(cached, {
        sortBy: url.searchParams.get("sortBy"),
        sortDirection: url.searchParams.get("sortDirection"),
        category: url.searchParams.get("category")
      });
      return new Response(JSON.stringify(preparedReports), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://namehim.app",
          "Cache-Control": "public, max-age=60"
        }
      });
    }

    try {
      const reports = await fetchAllReportsFromD1(env);
      if (reports && reports.length) {
        const preparedReports = sortAndFilterReports(reports, {
          sortBy: url.searchParams.get("sortBy"),
          sortDirection: url.searchParams.get("sortDirection"),
          category: url.searchParams.get("category")
        });
        if (env.CACHE_KV) {
          await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
          await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
        }
        return new Response(JSON.stringify(preparedReports), {
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
  // Rate limiting (unchanged)
  const ip = request.headers.get('CF-Connecting-IP');
  const rateLimitOptions = {
    key: `${ip}:submit`,
    limitKey: "submit",
    windows: [
      { limit: 1, window: 60 },
      { limit: 3, window: 3600 }
    ]
  };
  try {
    const { success } = await env.RATELIMITER.limit(rateLimitOptions);
    if (!success) return errorResponse("Rate limit exceeded. Please wait before trying again.", 429);
  } catch (err) { console.error("Rate limiter error:", err); }

  let payload;
  try { payload = await request.json(); } catch (err) { return errorResponse("Invalid JSON", 400); }

  if (!payload.name || !payload.city || !payload.country || !payload.categories)
    return errorResponse("Missing required fields", 400);

  // 🔒 Check blocked names
  const blockedSet = await getBlockedNamesSet(env);
  if (blockedSet.has(payload.name.toLowerCase()))
    return errorResponse("The name you entered is not allowed for submission.", 400);

  const token = payload.hcaptchaToken;
  if (!token) return errorResponse("CAPTCHA token missing", 400);

  const verifyRes = await fetch("https://api.hcaptcha.com/siteverify", {
    method: "POST",
    body: new URLSearchParams({
      secret: env.HCAPTCHA_SECRET,
      response: token,
      remoteip: ip || ""
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) {
    const errorCodes = Array.isArray(verifyData["error-codes"]) ? verifyData["error-codes"].join(", ") : "unknown";
    console.error("hCaptcha verify failed (/submit):", errorCodes);
    return errorResponse(`Invalid CAPTCHA (${errorCodes})`, 400);
  }

  const { hcaptchaToken, ...reportData } = payload;
  const db = env.DB;
  const categoriesJson = JSON.stringify(reportData.categories);
  const insertStmt = await db.prepare(`
    INSERT INTO reports (id, name, city, state, country, categories, created_at, submitter_uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    reportData.id || null,
    reportData.name,
    reportData.city,
    reportData.state || null,
    reportData.country,
    categoriesJson,
    reportData.created_at || new Date().toISOString(),
    reportData.submitter_uuid
  );
  
  try {
    const res = await insertStmt.run();
    if (!res.success) throw new Error("Insert failed");
  } catch (err) {
    console.error("Report insert failed:", err);
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
  // Rate limiting (unchanged)
  const ip = request.headers.get('CF-Connecting-IP');
  const rateLimitOptions = {
    key: `${ip}:story`,
    limitKey: "story",
    windows: [
      { limit: 1, window: 60 },
      { limit: 3, window: 3600 }
    ]
  };
  try {
    const { success } = await env.RATELIMITER.limit(rateLimitOptions);
    if (!success) return errorResponse("Rate limit exceeded. Please wait before trying again.", 429);
  } catch (err) { console.error("Rate limiter error:", err); }

  let payload;
  try { payload = await request.json(); } catch (err) { return errorResponse("Invalid JSON", 400); }

  const { title, content, submitter_uuid, hcaptchaToken } = payload;
  if (!content || typeof content !== "string") return errorResponse("Missing story content", 400);
  if (content.length > 1000) return errorResponse("Story too long", 400);
  if (!hcaptchaToken) return errorResponse("CAPTCHA token missing", 400);

  const verifyRes = await fetch("https://api.hcaptcha.com/siteverify", {
    method: "POST",
    body: new URLSearchParams({
      secret: env.HCAPTCHA_SECRET,
      response: hcaptchaToken,
      remoteip: ip || ""
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) {
    const errorCodes = Array.isArray(verifyData["error-codes"]) ? verifyData["error-codes"].join(", ") : "unknown";
    console.error("hCaptcha verify failed (/submit-story):", errorCodes);
    return errorResponse(`Invalid CAPTCHA (${errorCodes})`, 400);
  }

  const db = env.DB;
  const insertStmt = await db.prepare(`
    INSERT INTO stories (title, content, submitter_uuid, is_approved, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    title || null,
    content,
    submitter_uuid || null,
    0,
    new Date().toISOString(),
    "General"
  );
  
  try {
    const res = await insertStmt.run();
    if (!res.success) throw new Error("Insert failed");
  } catch (err) {
    console.error("Story insert failed:", err);
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

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: corsHeaders() });
}
__name(errorResponse, "errorResponse");

function normalizeSortBy(value) {
  const sortBy = String(value || "").trim().toLowerCase();
  return sortBy === "name" ? "name" : "created_at";
}
function normalizeSortDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return direction === "asc" ? "asc" : "desc";
}
function normalizeCategoryFilter(value) {
  return String(value || "").trim().toLowerCase();
}
function sortAndFilterReports(reports, options = {}) {
  const sortBy = normalizeSortBy(options.sortBy);
  const sortDirection = normalizeSortDirection(options.sortDirection);
  const category = normalizeCategoryFilter(options.category);
  const directionFactor = sortDirection === "asc" ? 1 : -1;

  const filtered = category
    ? reports.filter((report) => Array.isArray(report?.categories) && report.categories.some((item) => String(item || "").trim().toLowerCase() === category))
    : reports.slice();

  filtered.sort((a, b) => {
    if (sortBy === "name") {
      const nameA = String(a?.name || "").toLowerCase();
      const nameB = String(b?.name || "").toLowerCase();
      const cmp = nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp * directionFactor;
    } else {
      const dateA = Date.parse(a?.created_at || "") || 0;
      const dateB = Date.parse(b?.created_at || "") || 0;
      if (dateA !== dateB) return (dateA - dateB) * directionFactor;
    }
    return (Number(a?.id) - Number(b?.id)) * directionFactor;
  });

  return filtered;
}

async function refreshIfStale(env) {
  if (!env.CACHE_KV) return;
  const lastSuccess = await env.CACHE_KV.get(LAST_SUCCESS_KEY);
  const now = Date.now();
  if (lastSuccess && now - parseInt(lastSuccess) < 300000) return;
  const lock = await env.CACHE_KV.get(REFRESH_LOCK_KEY);
  if (lock) return;
  await env.CACHE_KV.put(REFRESH_LOCK_KEY, "1", { expirationTtl: 60 });
  try {
    const reports = await fetchAllReportsFromD1(env);
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

async function getBlockedNamesSet(env) {
  // Try to get from KV cache
  let blockedSet = null;
  try {
    const cached = await env.CACHE_KV.get(BLOCKED_NAMES_KEY);
    if (cached) blockedSet = new Set(JSON.parse(cached));
  } catch (e) { console.error("KV blocked names read error:", e); }
  if (blockedSet) return blockedSet;

  // Fetch from D1
  const db = env.DB;
  const { results } = await db.prepare("SELECT name FROM blocked_names").all();
  const names = results.map(row => row.name.toLowerCase());
  blockedSet = new Set(names);
  // Cache for 10 minutes (600 seconds)
  try {
    await env.CACHE_KV.put(BLOCKED_NAMES_KEY, JSON.stringify(Array.from(blockedSet)), { expirationTtl: 600 });
  } catch (e) { console.error("KV blocked names write error:", e); }
  return blockedSet;
}
__name(getBlockedNamesSet, "getBlockedNamesSet");

async function fetchAllReportsFromD1(env) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT id, name, city, state, country, categories, created_at, submitter_uuid FROM reports ORDER BY id DESC").all();
  if (!results || !results.length) return [];

  // Fetch blocked names
  const blockedSet = await getBlockedNamesSet(env);
  
  // Filter reports and parse categories
  const filtered = [];
  for (const row of results) {
    if (blockedSet.has(row.name.toLowerCase())) continue;
    let categories = [];
    try { categories = JSON.parse(row.categories); } catch(e) { categories = []; }
    filtered.push({
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      country: row.country,
      categories: categories,
      created_at: row.created_at,
      submitter_uuid: row.submitter_uuid
    });
  }
  return filtered;
}
__name(fetchAllReportsFromD1, "fetchAllReportsFromD1");
