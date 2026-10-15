# Organiser checklist — before opening registrations

Tick everything before turning registration on. The Settings page also lists missing payment items.

## Information only the organisers can provide
- [ ] **Registration fee** (₹ amount)
- [ ] **UPI payee name** (as it appears on the bank/UPI account)
- [ ] **UPI ID** (e.g. `name@bank`)
- [ ] **Official UPI QR image** (JPG/PNG/WEBP, ≤ 2 MB) — the organisation's own, not a screenshot of someone else's
- [ ] **Approved school list** (optional but recommended; one name per line). Without it students type their school and spellings will vary in reports
- [ ] **Final examination centre** — currently *tentative*: Narbheram Hansraj English School, Jamshedpur. Edit and tick “centre is final” when confirmed
- [ ] **Confirm class/shift timings** (seeded: Class 7 & 9 → Shift 1, 10:00 AM–12:00 PM, report 9:30 AM; Class 8 & 10 → Shift 2, 1:30–3:30 PM, report 1:00 PM)
- [ ] Names and emails of the **administrators** who will verify payments

## Services / accounts the technical owner must set up
- [ ] Supabase project created; migrations applied (`supabase db push`)
- [ ] Auth: public sign-ups **disabled**
- [ ] `payment-proofs` bucket confirmed **Private**
- [ ] Secrets set: `ALLOWED_ORIGINS`, `IP_HASH_SALT`, `CLEANUP_SECRET`
- [ ] Edge Functions deployed: `register`, `admin`, `cleanup`
- [ ] Hourly cleanup scheduled
- [ ] Admin users created and added to `admin_users`
- [ ] GitHub repo created and code pushed
- [ ] Netlify site connected to the repo; env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set; deploy succeeded
- [ ] `ALLOWED_ORIGINS` secret set to the Netlify site's origin

## Dry run (staging or production with registration still closed → then open briefly)
- [ ] Register one student in each of Class 7, 8, 9, 10 on a real phone; check the confirmation shows the right shift and reporting time
- [ ] Try submitting twice quickly, with a wrong file type, and with a file over 5 MB
- [ ] As admin: open a registration, view the proof, reject without a reason (should be refused), reject with a reason, then verify
- [ ] Export CSV and Excel; open in Excel; check leading zeros in roll numbers and that notes are absent
- [ ] Print a class-wise and a school-wise list
- [ ] Confirm a non-admin account cannot see anything at `#/admin`
- [ ] Delete the test registrations (SQL editor) before the real launch

## Privacy
- [ ] Decide how long student data and payment screenshots are kept after the event, and delete them accordingly
- [ ] Share the admin password only with named organisers; use strong unique passwords
