-- Migration: allow public to add categories to existing reports (append-only enforced in UI)
-- Run this against your live Supabase project via the SQL editor.

create policy if not exists "Public can update report categories"
on public.reports
for update
to anon, authenticated
using (true)
with check (true);
