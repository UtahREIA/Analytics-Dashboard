# SOP — Set Up TikTok API Access for the Utah REIA Analytics Dashboard

**For:** The TikTok account admin for **@utah_reia** (someone with admin access to the TikTok account who can create a TikTok Developer app)
**Requested by:** David (Analytics Dashboard project)
**Time needed:** ~30 minutes of setup, then a **wait for TikTok's review** (often several days)
**Goal:** Create and approve a TikTok Developer app so the analytics dashboard can automatically read **@utah_reia**'s stats (followers, likes, video count, and per-video views/likes/comments/shares). This is **read-only reporting** — it never posts, messages, or changes anything.

---

## Read this first — TikTok is different

Unlike YouTube and Facebook/Instagram (where we can read our own account right away), **TikTok requires a manual app review before any data will flow.** So this SOP has two phases:

- **Phase 1 (you, now):** create the app, request the data permissions, and submit it for review.
- **Phase 2 (after TikTok approves):** a quick one-click authorization by you, then David finishes the technical connection.

Please do **Phase 1** as soon as you can — the review clock only starts once it's submitted.

---

## Before you start (checklist)

- [ ] You can log in to **@utah_reia** on TikTok (you'll authorize it later).
- [ ] You have (or can get from David) two public web links: a **Privacy Policy URL** and **Terms of Service URL** — use `https://utahreia.com/privacy-policy` and `https://utahreia.com/terms-of-use` unless David says otherwise.
- [ ] One value from David before you start: the **Redirect URI** to register (David will confirm it; the planned value is `https://analytics-dashboard-beta-three.vercel.app/api/tiktok-oauth`).
- [ ] Use a **normal, consistent connection** (don't toggle VPN mid-session).

---

## Phase 1 — Create and submit the app

### Part A — Register as a developer
1. Go to **[developers.tiktok.com](https://developers.tiktok.com)** and **log in** (you can use the @utah_reia TikTok login, or your own TikTok account — either works to *own the app*; the account whose *data* we read is chosen later during authorization).
2. Complete the one-time **developer registration** if prompted (name, email, agree to terms).

### Part B — Create the app
3. Go to **Manage apps → Connect an app** (or **Create app**).
4. Fill in:
   - **App name:** `Utah REIA Analytics`
   - **Description:** "Internal analytics dashboard that reads Utah REIA's own TikTok account statistics (followers and video performance) for reporting. Read-only."
   - **Category:** Business / Analytics.
   - **App icon:** the Utah REIA logo (any square PNG).

### Part C — Add the products (permissions groups)
5. In the app, **add products**:
   - **Login Kit** — required for the secure authorization step.
   - **Display API** — gives account stats and the video list.
6. Under **scopes**, request these four:
   - `user.info.basic`
   - `user.info.profile`
   - `user.info.stats`
   - `video.list`

### Part D — Configure settings
7. **Platform:** add **Web**.
8. **Redirect URI:** paste the value from David (planned: `https://analytics-dashboard-beta-three.vercel.app/api/tiktok-oauth`). This must match **exactly** or authorization will fail later.
9. **Privacy Policy URL** and **Terms of Service URL:** paste the two links from the checklist.

### Part E — Add the account for testing (sandbox)
10. If the app has a **Sandbox / Target users** section, **add @utah_reia as a target user**. This lets David test the connection before TikTok's full approval comes through.

### Part F — Submit for review
11. Click **Submit for review**.
12. If TikTok asks for a **demo video or usage explanation**, describe it simply: *"A private internal dashboard authorizes the Utah REIA TikTok account and displays its own follower and video statistics for the team. No content is posted or modified."* David can supply a short screen recording if one is required.
13. After submitting, **tell David** it's in review.

---

## Phase 2 — After TikTok approves (quick)

You'll get an email from TikTok when the app is approved. Then:

1. **David sends you an authorization link.** Open it **while logged into @utah_reia**, review the permissions, and click **Authorize**. That's it on your side.
2. David captures the connection token from that step and finishes the setup. No further action from you.

---

## Hand off to David (securely)

The **Client Key** and **Client Secret** identify the app. The Client Secret is a **password-equivalent** — don't email or message it in plain text.

- ✅ Save the **Client Key** and **Client Secret** in **LastPass** (Utah REIA's approved place for keys) and share that entry with **David**. Name it e.g. `TikTok App — Analytics Dashboard`.
- Also tell David (normal message is fine, these aren't secret): the **app name/ID**, that it's **submitted for review**, and that **@utah_reia was added as a target user**.

---

## Reference — the account this covers

| Asset | Name |
|---|---|
| TikTok (Business) | @utah_reia |

---

## Notes

- **Review time varies** (often a few days, sometimes longer). The connection won't work until TikTok approves the requested scopes.
- **This is read-only reporting** — the dashboard only reads stats; it never posts, comments, or changes settings.
- Once connected, TikTok's access renews automatically on the dashboard's side (TikTok tokens are short-lived and refresh behind the scenes) — you won't need to re-authorize unless the app is removed or access is revoked.
- Keep the app and its approval in place so the daily reporting keeps working.
- Questions on any step → reach David.
