# NameHim

Community-driven safety awareness platform. Users can anonymously submit reports about concerning behaviour (emotional/physical abuse, stalking, sexual assault, rape, etc.) and share personal stories of hope and survival.

**Live site:** [https://namehim.app](https://namehim.app)

---

## Tech stack

- **Frontend:** HTML/CSS/JS (no build step), hosted on Cloudflare Pages
- **Backend API:** Cloudflare Worker (filters, CAPTCHA, cache, Supabase proxy)
- **Database:** Supabase (PostgreSQL with Row Level Security)
- **CAPTCHA:** Cloudflare Turnstile
- **Maps:** Simplemaps US & World maps (interactive)

---

## Key features

- Browse reports with pagination, search, and country/state filters
- Interactive US and World maps that highlight report counts per region
- Submit reports with CAPTCHA protection and client‑side rate limiting
- Community Stories: anonymous, un‑named posts that are reviewed before going live
- All reports are sanitised and filtered to block malicious entries and blocked names

---

## API (Cloudflare Worker)

The frontend communicates with a Worker at `https://api.namehim.app/` which provides:

- `GET /filtered-reports` – returns all reports after filtering out blocked names and malicious payloads (cached in Cloudflare KV)
- `POST /submit` – submits a new safety report (validates Turnstile, inserts into Supabase)
- `POST /submit-story` – submits a community story (requires approval, not live immediately)
- - `GET /version` – returns the current Git commit hash and source link, allowing anyone to verify that the live worker matches the public code.

The worker uses environment variables for secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TURNSTILE_SECRET_KEY). The source code is open in /worker/index.js and is automatically deployed from this repository via Cloudflare Workers Git integration (branch: main, root directory: worker/).
Every push to main updates the live worker instantly. Secrets remain in Cloudflare environment variables – never committed.

---

## Database schema (Supabase)

### Reports table

```sql
CREATE TABLE public.reports (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NULL,
  country TEXT NOT NULL,
  categories TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitter_uuid TEXT NOT NULL
);

-- RLS: anyone can view and insert (submissions go through worker, but direct insert is allowed with valid RLS)
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert reports" ON public.reports FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can view reports"   ON public.reports FOR SELECT USING (true);

Stories table
sql
CREATE TABLE public.stories (
  id SERIAL PRIMARY KEY,
  title TEXT NULL,
  content TEXT NOT NULL,
  submitter_uuid TEXT NULL,
  is_approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: anyone can insert, but only approved stories can be viewed (public)
ALTER TABLE public.stories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can submit stories" ON public.stories FOR INSERT WITH CHECK (true);
CREATE POLICY "View only approved stories" ON public.stories FOR SELECT USING (is_approved = true);
Blocked names table (optional, used by worker)
sql
CREATE TABLE public.blocked_names (name TEXT PRIMARY KEY);
Environment variables
Frontend (hardcoded in index.html – replace if you fork):

SUPABASE_URL

SUPABASE_ANON_KEY

TURNSTILE_SITE_KEY

Worker (set in Cloudflare Dashboard → Worker → Variables):

SUPABASE_URL

SUPABASE_SERVICE_ROLE_KEY

TURNSTILE_SECRET_KEY

CACHE_KV (KV namespace binding for caching)

Local development
Clone the repo.

Run a static server: python3 -m http.server

Open http://localhost:8000

The site will attempt to fetch reports from the live worker (api.namehim.app). For offline development, you can change the WORKER_URL in index.html to a local mock.

## Transparency & open source

The entire frontend (`index.html`) and worker source (`worker/index.js`) are public. Secrets are never committed – they are injected via environment variables.

**Live worker source** is automatically deployed from this repository. Each deployment corresponds to a specific commit. You can verify that the running code matches the GitHub file by:

1. Visiting `https://api.namehim.app/version` – this endpoint returns the current Git commit hash and the source URL.
2. Comparing the returned hash with the latest commit on the `main` branch of this GitHub repository (or the specific commit linked in the response).

Example response:
```json
{
  "commit": "756347f9c3e4c4064eb636db54e3a1d287986197",
  "source": "https://github.com/namehim/namehim/blob/main/worker/index.js"
}

License & contributions
Open source – feel free to fork and improve.
Issues: https://github.com/namehim/namehim/issues
