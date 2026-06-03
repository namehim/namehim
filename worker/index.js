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
    try {
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
      const reports = await getReportsForRead(env, ctx, { bypassCache: shouldBypassCache(url) });

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
      const reports = await getReportsForRead(env, ctx, { bypassCache: shouldBypassCache(url) });

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
        const [stories, total] = await Promise.all([
          fetchApprovedStoriesFromD1(env, storyId),
          countApprovedStoriesFromD1(env)
        ]);
        return new Response(JSON.stringify({ stories, total }), {
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
    const reports = await getReportsForRead(env, ctx, { bypassCache: shouldBypassCache(url) });
    if (Array.isArray(reports)) {
      const preparedReports = sortAndFilterReports(reports, {
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

    return new Response(JSON.stringify({ error: "Service temporarily unavailable. Please try again in a minute." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://namehim.app" }
    });
    } catch (err) {
      console.error("Unhandled worker error:", err);
      return errorResponse("Service unavailable. Please try again in a moment.", 500);
    }
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
  const db = getD1Database(env);
  const reportColumns = await getTableColumns(db, "reports");
  const insertColumns = [];
  const insertValues = [];

  addInsertValue(insertColumns, insertValues, reportColumns, "name", reportData.name);
  addInsertValue(insertColumns, insertValues, reportColumns, "city", reportData.city);
  addInsertValue(insertColumns, insertValues, reportColumns, "state", reportData.state || null);
  addInsertValue(insertColumns, insertValues, reportColumns, "country", reportData.country);
  if (reportColumns.has("categories")) {
    addInsertValue(insertColumns, insertValues, reportColumns, "categories", JSON.stringify(reportData.categories));
  } else if (reportColumns.has("category")) {
    addInsertValue(insertColumns, insertValues, reportColumns, "category", reportData.categories[0] || null);
  }
  addInsertValue(insertColumns, insertValues, reportColumns, "created_at", reportData.created_at || new Date().toISOString());
  addInsertValue(insertColumns, insertValues, reportColumns, "submitter_uuid", reportData.submitter_uuid || null);

  if (!insertColumns.includes("name")) {
    return errorResponse("Reports table is missing required name column", 500);
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  const insertStmt = await db.prepare(`
    INSERT INTO reports (${insertColumns.join(", ")})
    VALUES (${placeholders})
  `).bind(...insertValues);
  
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

  const db = getD1Database(env);
  const storyColumns = await getTableColumns(db, "stories");
  const insertColumns = ["content"];
  const insertValues = [content];
  if (storyColumns.has("title")) {
    insertColumns.push("title");
    insertValues.push(title || null);
  }
  if (storyColumns.has("submitter_uuid")) {
    insertColumns.push("submitter_uuid");
    insertValues.push(submitter_uuid || null);
  }
  if (storyColumns.has("is_approved")) {
    insertColumns.push("is_approved");
    insertValues.push(0);
  }
  if (storyColumns.has("approved")) {
    insertColumns.push("approved");
    insertValues.push(0);
  }
  if (storyColumns.has("created_at")) {
    insertColumns.push("created_at");
    insertValues.push(new Date().toISOString());
  }
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

function getD1Database(env) {
  if (env.DB && typeof env.DB.prepare === "function") return env.DB;
  if (env["nameham-db"] && typeof env["nameham-db"].prepare === "function") return env["nameham-db"];
  for (const value of Object.values(env || {})) {
    if (value && typeof value.prepare === "function") return value;
  }
  if (typeof env.DB === "string") {
    throw new Error("D1 binding DB is set as a text variable. Configure DB as a Cloudflare D1 binding to nameham-db, not as an environment variable.");
  }
  throw new Error("D1 binding DB is not configured. Add a Cloudflare D1 binding named DB for nameham-db.");
}
__name(getD1Database, "getD1Database");

function shouldBypassCache(url) {
  return url.searchParams.has("refresh") || url.searchParams.has("t");
}
__name(shouldBypassCache, "shouldBypassCache");

function addInsertValue(columns, values, availableColumns, column, value) {
  if (!availableColumns.has(column)) return;
  columns.push(column);
  values.push(value);
}
__name(addInsertValue, "addInsertValue");

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

async function readCachedReports(env) {
  try {
    if (!env.CACHE_KV) return null;
    const cached = await env.CACHE_KV.get(CACHE_KEY, "json");
    return Array.isArray(cached) ? cached : null;
  } catch (err) {
    console.error("KV read error:", err);
    return null;
  }
}
__name(readCachedReports, "readCachedReports");

async function writeReportsCache(env, reports) {
  if (!env.CACHE_KV || !Array.isArray(reports)) return;
  try {
    await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(reports));
    await env.CACHE_KV.put(LAST_SUCCESS_KEY, Date.now().toString());
  } catch (err) {
    console.error("KV write error:", err);
  }
}
__name(writeReportsCache, "writeReportsCache");

async function getReportsForRead(env, ctx, options = {}) {
  const bypassCache = Boolean(options.bypassCache);
  const cached = await readCachedReports(env);

  if (cached && !bypassCache) {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(refreshIfStale(env));
    return cached;
  }

  try {
    const reports = await fetchAllReportsFromD1(env);
    if (Array.isArray(reports)) {
      await writeReportsCache(env, reports);
      return reports;
    }
  } catch (err) {
    console.error("D1 reports fetch failed:", err);
  }

  if (cached) {
    console.warn("Serving stale reports cache after D1 fetch failure.");
    return cached;
  }

  return null;
}
__name(getReportsForRead, "getReportsForRead");

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
  const db = getD1Database(env);
  let results = [];
  try {
    ({ results } = await db.prepare("SELECT name FROM blocked_names").all());
  } catch (err) {
    console.warn("Blocked names table unavailable; continuing without blocked-name filtering:", err);
    results = [];
  }
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

function getStoryApprovalFilter(storyColumns) {
  const approvalColumn = storyColumns.has("is_approved") ? "is_approved" : (storyColumns.has("approved") ? "approved" : null);
  return approvalColumn
    ? `(${approvalColumn} = 1 OR ${approvalColumn} = true OR lower(CAST(${approvalColumn} AS TEXT)) = 'true')`
    : "1 = 1";
}
__name(getStoryApprovalFilter, "getStoryApprovalFilter");

async function countApprovedStoriesFromD1(env) {
  const db = getD1Database(env);
  const storyColumns = await getTableColumns(db, "stories");
  if (!storyColumns.size) {
    throw new Error("stories table is missing or has no columns");
  }
  const approvalFilter = getStoryApprovalFilter(storyColumns);
  const { results } = await db.prepare(`SELECT COUNT(*) AS total FROM stories WHERE ${approvalFilter}`).all();
  const row = results && results[0] ? results[0] : {};
  return Number(row.total) || 0;
}
__name(countApprovedStoriesFromD1, "countApprovedStoriesFromD1");

async function fetchApprovedStoriesFromD1(env, storyId = null) {
  const db = getD1Database(env);

  const storyColumns = await getTableColumns(db, "stories");
  if (!storyColumns.has("content")) {
    throw new Error("stories table is missing required content column");
  }

  const idColumn = storyColumns.has("id") ? "id" : "rowid";
  const createdAtColumn = storyColumns.has("created_at") ? "created_at" : null;
  const selectColumns = [
    `${idColumn} AS id`,
    storyColumns.has("title") ? "title" : "NULL AS title",
    "content",
    createdAtColumn ? `${createdAtColumn} AS created_at` : "NULL AS created_at",
    storyColumns.has("category") ? "category" : "'General' AS category",
    storyColumns.has("admin_reply") ? "admin_reply" : "'' AS admin_reply"
  ];
  const approvalFilter = getStoryApprovalFilter(storyColumns);
  const orderBy = createdAtColumn ? `${createdAtColumn} DESC` : `${idColumn} DESC`;

  const baseSelect = `SELECT ${selectColumns.join(", ")} FROM stories WHERE ${approvalFilter}`;
  const stmt = storyId
    ? db.prepare(`${baseSelect} AND ${idColumn} = ? ORDER BY ${orderBy} LIMIT 1`).bind(storyId)
    : db.prepare(`${baseSelect} ORDER BY ${orderBy}`);
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

function parseCategoriesValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
    if (typeof parsed === "string") return [parsed.trim()].filter(Boolean);
  } catch (e) {}
  if (raw.startsWith("{") && raw.endsWith("}")) {
    return raw.slice(1, -1).split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
__name(parseCategoriesValue, "parseCategoriesValue");

async function fetchAllReportsFromD1(env) {
  const db = getD1Database(env);
  const reportColumns = await getTableColumns(db, "reports");
  if (!reportColumns.size) {
    throw new Error("reports table is missing or has no columns");
  }
  if (!reportColumns.has("name")) {
    throw new Error("reports table is missing required name column");
  }

  const idColumn = reportColumns.has("id") ? "id" : "rowid";
  const createdAtColumn = reportColumns.has("created_at") ? "created_at" : (reportColumns.has("createdAt") ? "createdAt" : null);
  const categoriesExpr = reportColumns.has("categories")
    ? "categories"
    : (reportColumns.has("category") ? "category AS categories" : "NULL AS categories");
  const selectColumns = [
    `${idColumn} AS id`,
    "name",
    reportColumns.has("city") ? "city" : "NULL AS city",
    reportColumns.has("state") ? "state" : "NULL AS state",
    reportColumns.has("country") ? "country" : "NULL AS country",
    categoriesExpr,
    createdAtColumn ? `${createdAtColumn} AS created_at` : "NULL AS created_at",
    reportColumns.has("submitter_uuid") ? "submitter_uuid" : "NULL AS submitter_uuid"
  ];
  const orderBy = createdAtColumn ? `${createdAtColumn} DESC` : `${idColumn} DESC`;
  const { results } = await db.prepare(`SELECT ${selectColumns.join(", ")} FROM reports ORDER BY ${orderBy}`).all();
  if (!results || !results.length) return [];

  // Fetch blocked names
  const blockedSet = await getBlockedNamesSet(env);
  
  // Filter reports and parse categories
  const filtered = [];
  for (const row of results) {
    if (blockedSet.has(String(row.name || "").toLowerCase())) continue;
    filtered.push({
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      country: row.country,
      categories: parseCategoriesValue(row.categories),
      created_at: row.created_at,
      submitter_uuid: row.submitter_uuid
    });
  }
  return filtered;
}
__name(fetchAllReportsFromD1, "fetchAllReportsFromD1");
