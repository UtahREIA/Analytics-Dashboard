# SOP — Set Up LinkedIn API Access for the Utah REIA Analytics Dashboard

**For:** An **Admin of the Utah REIA LinkedIn Company Page** ("Utah Real Estate Investors Association") who can create a LinkedIn Developer app
**Requested by:** David (Analytics Dashboard project)
**Time needed:** ~30 minutes of setup, then a **wait for LinkedIn's review** (can take several days to a couple of weeks)
**Goal:** Create and get approval for a LinkedIn Developer app so the analytics dashboard can automatically read the Utah REIA **Company Page** stats (followers, follower growth, page views, and post impressions/engagement). **Read-only reporting** — it never posts or changes anything.

---

## Read this first — LinkedIn is the slowest of our connections

Like TikTok, LinkedIn requires a **review/approval** before data flows, and its analytics live behind a product called the **Community Management API** that you have to **apply for**. So this SOP is two phases:

- **Phase 1 (you, now):** create the app, link it to the Company Page, verify it, and apply for the Community Management API.
- **Phase 2 (after LinkedIn approves):** a quick one-click authorization by you, then David finishes the technical connection.

Please do **Phase 1** as soon as possible — LinkedIn's approval is the longest wait of all our platforms, so starting early matters most here.

---

## Before you start (checklist)

- [ ] You are an **Admin** (super admin) of the **Utah Real Estate Investors Association** LinkedIn **Company Page**.
- [ ] You have a **personal LinkedIn account** to own the developer app (apps are owned by a person, then linked to the Page).
- [ ] A public **Privacy Policy URL** — use `https://utahreia.com/privacy-policy` unless David says otherwise.
- [ ] One value from David: the **Redirect URL** to register (planned: `https://analytics-dashboard-beta-three.vercel.app/api/linkedin-oauth`).
- [ ] A square **app logo** (the Utah REIA logo works).
- [ ] Use a **normal, consistent connection** (don't toggle VPN mid-session).

---

## Phase 1 — Create, link, verify, and apply

### Part A — Create the app
1. Go to **[linkedin.com/developers/apps](https://www.linkedin.com/developers/apps)** → **Create app**.
2. Fill in:
   - **App name:** `Utah REIA Analytics`
   - **LinkedIn Page:** type and select **Utah Real Estate Investors Association** (this links the app to the Company Page — required).
   - **Privacy policy URL:** paste the link from the checklist.
   - **App logo:** upload the Utah REIA logo.
3. Agree to the terms → **Create app**.

### Part B — Verify the app with the Company Page
4. After creation, LinkedIn shows a **"Verify"** step for the linked Page. Click it to generate a **verification link**.
5. As a **Page admin**, open that link and **confirm** — this proves the app is authorized to act for the Utah REIA Page. (If someone else is the Page admin, send them the link to click.)

### Part C — Note the app credentials
6. Open the **Auth** tab. You'll see a **Client ID** and **Client Secret**. You'll hand these to David later (securely — see below).
7. On the **Auth** tab, under **OAuth 2.0 settings → Authorized redirect URLs**, add the **Redirect URL** from David (planned: `https://analytics-dashboard-beta-three.vercel.app/api/linkedin-oauth`). It must match **exactly**.

### Part D — Request the data products
8. Open the **Products** tab and **request access** to:
   - **Community Management API** — this unlocks the Company Page follower and analytics data we need. (**This one requires an application/review.**)
   - **Sign In with LinkedIn using OpenID Connect** — for the sign-in step (usually granted instantly).
9. If the Community Management API shows an **application form**, describe the use case simply: *"A private internal dashboard for Utah REIA reads our own Company Page's follower counts, page views, and post engagement for team reporting. Read-only; no posting or messaging."*

### Part E — Submit and notify
10. Submit the Community Management API request.
11. **Tell David** the app is created, linked, verified, and the API request is submitted.

---

## Phase 2 — After LinkedIn approves (quick)

You'll be notified when the Community Management API is granted. Then:

1. **David sends you an authorization link.** Open it **while logged into the LinkedIn account that admins the Page**, review the permissions, and click **Allow**.
2. David captures the connection token and finishes setup. No further action from you.

---

## Hand off to David (securely)

The **Client ID** and **Client Secret** identify the app. The Client Secret is a **password-equivalent** — don't email or message it in plain text.

- ✅ Save the **Client ID** and **Client Secret** in **LastPass** (Utah REIA's approved place for keys) and share that entry with **David**. Name it e.g. `LinkedIn App — Analytics Dashboard`.
- Also tell David (normal message is fine, not secret): the **app name**, that it's **linked and verified** to the Company Page, and that the **Community Management API** request is **submitted / approved**.

---

## Reference — the account this covers

| Asset | Name | Page ID |
|---|---|---|
| LinkedIn Company Page | Utah Real Estate Investors Association | `3763836` |

---

## Notes

- **Approval is the long pole.** The Community Management API is reviewed by LinkedIn and can take from a few days to a couple of weeks. Nothing works until it's granted — which is exactly why we're starting it early.
- **This is read-only reporting** — the dashboard only reads Page stats; it never posts, comments, or changes settings.
- Once connected, access renews automatically on the dashboard's side (LinkedIn tokens are refreshed behind the scenes) — you won't need to re-authorize unless the app is removed or the Page link is revoked.
- Keep the app, the Page link, and the API approval in place so the daily reporting keeps working.
- Questions on any step → reach David.
