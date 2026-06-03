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
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(refreshIfStale(env));
      } else {
        reports = await fetchAllReportsFromD1(env);
        if (Array.isArray(reports) && env.CACHE_KV) {
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
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(refreshIfStale(env));
      } else {
        reports = await fetchAllReportsFromD1(env);
        if (Array.isArray(reports) && env.CACHE_KV) {
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

    // GET /stories – approved community stories from D1
    if (request.method === "GET" && url.pathname === "/stories") {
      const storyId = url.searchParams.get("id");
      try {
        const stories = await fetchApprovedStoriesFromD1(env, storyId);
        return new Response(JSON.stringify({ stories }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      } catch (err) {
        console.error("Stories fetch failed:", err);
        return errorResponse("Unable to load stories", 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmitReport(request, env);
    }
    if (request.method === "POST" && url.pathname === "/submit-story") {
      return handleSubmitStory(request, env);
    }

    if (request.method !== "GET" || (url.pathname !== "/filtered-reports" && url.pathname !== "/")) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });
    }

    // ----- GET /filtered-reports (full list, legacy) -----
    let cached = null;
    try {
      if (env.CACHE_KV) cached = await env.CACHE_KV.get(CACHE_KEY, "json");
    } catch (e) { console.error("KV read error:", e); }

    if (cached && Array.isArray(cached)) {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(refreshIfStale(env));
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
      if (Array.isArray(reports)) {
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

  const token = payload.turnstileToken;
  if (!token) return errorResponse("CAPTCHA token missing", 400);

  const verifyResult = await verifyTurnstileToken(token, env, ip);
  if (!verifyResult.success) {
    console.error("Turnstile verify failed (/submit):", verifyResult.errorCodes);
    return errorResponse("Invalid CAPTCHA", 400);
  }

  const { turnstileToken, ...reportData } = payload;
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

  const { title, content, category, submitter_uuid, turnstileToken } = payload;
  if (!content || typeof content !== "string") return errorResponse("Missing story content", 400);
  if (content.length > 1000) return errorResponse("Story too long", 400);
  if (!turnstileToken) return errorResponse("CAPTCHA token missing", 400);

  const verifyResult = await verifyTurnstileToken(turnstileToken, env, ip);
  if (!verifyResult.success) {
    console.error("Turnstile verify failed (/submit-story):", verifyResult.errorCodes);
    return errorResponse("Invalid CAPTCHA", 400);
  }

  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is not configured");
  const storyColumns = await getTableColumns(db, "stories");
  const insertColumns = ["title", "content", "submitter_uuid", "is_approved", "created_at"];
  const insertValues = [title || null, content, submitter_uuid || null, 0, new Date().toISOString()];
  if (storyColumns.has("category")) {
    insertColumns.push("category");
    insertValues.push(category || "General");
  }
  const placeholders = insertColumns.map(() => "?").join(", ");
  const insertStmt = await db.prepare(`
    INSERT INTO stories (${insertColumns.join(", ")})
    VALUES (${placeholders})
  `).bind(...insertValues);
  
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

async function verifyTurnstileToken(token, env, ip) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { success: false, errorCodes: "missing-secret" };
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token
  });
  if (ip) body.set("remoteip", ip);

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  const verifyData = await verifyRes.json();
  return {
    success: Boolean(verifyData.success),
    errorCodes: Array.isArray(verifyData["error-codes"]) ? verifyData["error-codes"].join(", ") : "unknown"
  };
}
__name(verifyTurnstileToken, "verifyTurnstileToken");

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
    if (env.CACHE_KV) {
      const cached = await env.CACHE_KV.get(BLOCKED_NAMES_KEY);
      if (cached) blockedSet = new Set(JSON.parse(cached));
    }
  } catch (e) { console.error("KV blocked names read error:", e); }
  if (blockedSet) return blockedSet;

  // Fetch from D1
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is not configured");
  const { results } = await db.prepare("SELECT name FROM blocked_names").all();
  const names = (results || []).map(row => String(row.name || "").toLowerCase()).filter(Boolean);
  blockedSet = new Set(names);
  // Cache for 10 minutes (600 seconds)
  try {
    if (env.CACHE_KV) await env.CACHE_KV.put(BLOCKED_NAMES_KEY, JSON.stringify(Array.from(blockedSet)), { expirationTtl: 600 });
  } catch (e) { console.error("KV blocked names write error:", e); }
  return blockedSet;
}
__name(getBlockedNamesSet, "getBlockedNamesSet");

async function getTableColumns(db, tableName) {
  const { results } = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set((results || []).map((column) => column.name));
}
__name(getTableColumns, "getTableColumns");

async function fetchApprovedStoriesFromD1(env, storyId = null) {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is not configured");

  const storyColumns = await getTableColumns(db, "stories");
  const selectColumns = ["id", "title", "content", "created_at"];
  if (storyColumns.has("category")) selectColumns.push("category");
  if (storyColumns.has("admin_reply")) selectColumns.push("admin_reply");

  const baseSelect = `SELECT ${selectColumns.join(", ")} FROM stories WHERE is_approved = 1`;
  const stmt = storyId
    ? db.prepare(`${baseSelect} AND id = ? ORDER BY created_at DESC LIMIT 1`).bind(storyId)
    : db.prepare(`${baseSelect} ORDER BY created_at DESC`);
  const { results } = await stmt.all();
  return (results || []).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    created_at: row.created_at,
    category: row.category || "General",
    admin_reply: row.admin_reply || ""
  }));
}
__name(fetchApprovedStoriesFromD1, "fetchApprovedStoriesFromD1");

async function fetchAllReportsFromD1(env) {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is not configured");
  const { results } = await db.prepare("SELECT id, name, city, state, country, categories, created_at, submitter_uuid FROM reports ORDER BY id DESC").all();
  if (!results || !results.length) return [];

  // Fetch blocked names
  const blockedSet = await getBlockedNamesSet(env);
  
  // Filter reports and parse categories
  const filtered = [];
  for (const row of results) {
    if (blockedSet.has(String(row.name || "").toLowerCase())) continue;
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
