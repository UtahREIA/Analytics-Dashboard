# SOP — Create a Meta (Facebook + Instagram) Access Token for the Utah REIA Analytics Dashboard

**For:** Kingsley
**Requested by:** David (Analytics Dashboard project)
**Time needed:** ~15 minutes, one time
**Goal:** Generate a **non-expiring System User access token** so the analytics dashboard can automatically read Utah REIA's Facebook Page and Instagram statistics (followers, reach, views, engagement). This is read-only reporting — it never posts, changes, or deletes anything.

---

## Why you (and not David)

The dashboard pulls Facebook + Instagram numbers directly from Meta's official API so they're accurate (we're replacing Metricool). To do that it needs a token, and a token can only be created by someone with **admin access to Utah REIA's Meta Business, Facebook Page, and Instagram** — that's you. Once you hand the token over, it runs on its own; you won't need to touch it again.

---

## Before you start (checklist)

- [ ] You're an **Admin** on Utah REIA's **Meta Business portfolio** (Business Manager).
- [ ] You have **full control** of the Facebook Page **"Utah Real Estate Investors Association"** and the Instagram account **@utah.reia**.
- [ ] The Instagram account is a **Business or Creator** account **linked to the Facebook Page** (it already is — this is just a confirmation).
- [ ] Use your **normal internet connection** and **don't switch VPN on/off** partway through (a mid-session IP change is what trips Meta's security checks — staying consistent avoids them).

> If a "confirm it's you" security prompt appears at any point, just approve it. That's routine and won't harm the account.

---

## Part A — Pick or create a Developer App

1. Go to **[developers.facebook.com](https://developers.facebook.com)** → **My Apps**.
2. If Utah REIA **already has an app**, use it and skip to Part B.
3. Otherwise click **Create App** → choose type **Business** → name it **`Utah REIA Analytics`** → connect it to the Utah REIA **Business portfolio** → Create.
4. Leave the app in **Development mode**. (That's fine — reading our *own* Page/Instagram does **not** require Meta App Review.)
5. Jot down the **App ID** (shown at the top of the app dashboard — it's not secret).

---

## Part B — Create a System User

A "System User" is a non-human account used for automated access. Its token doesn't expire, which is what a daily automated report needs.

1. Go to **[business.facebook.com](https://business.facebook.com)** → click the **gear icon (Business Settings)**.
2. In the left menu: **Users → System Users**.
3. Click **Add** → name it **`Analytics Reader`** → role **Admin** → **Create System User**.

---

## Part C — Give the System User access to the assets

Still on the System User you just created:

1. Click **Add Assets**.
2. **Pages** → select **Utah Real Estate Investors Association** → turn on **Full control** → Save.
3. **Instagram accounts** → select **@utah.reia** → turn on **Full control** → Save.
4. **Apps** → select the app from Part A → turn on **Full control / Manage** → Save.

> "Full control" is the simplest choice. (The token is still read-only for our purposes — we only call reporting endpoints.)

---

## Part D — Generate the token

Still on the System User:

1. Click **Generate New Token**.
2. **App:** select the app from Part A.
3. **Token expiration:** choose **Never**.
4. **Permissions / scopes:** check **all six** of these:
   - `pages_show_list`
   - `pages_read_engagement`
   - `read_insights`
   - `instagram_basic`
   - `instagram_manage_insights`
   - `business_management`
5. Click **Generate Token**.
6. **Copy the token immediately** — Meta shows it **only once**. It's a long string starting with `EAAG...` or similar.

---

## Part E — Hand the token over securely

The token is a **password-equivalent**. Anyone with it can read our Meta reporting data, so don't let it leak.

- ❌ **Do not** paste it into email, Slack, SMS, or a chat message.
- ✅ **Do** save it in **LastPass** (Utah REIA's approved place for keys) and share that entry with **David** — or use whatever secure handoff method you and David agree on.
- Name the LastPass item clearly, e.g. **`Meta System User Token — Analytics Dashboard`**, and tell David the item name.

Along with the token, please send David (these are **not** secret, so normal message is fine):
- The **App ID** from Part A.
- Confirmation that the **Page** and **Instagram** were both assigned to the System User.

---

## Quick self-check (optional, ~1 minute)

If you want to confirm the token works before handing it over:

1. Go to **[Graph API Explorer](https://developers.facebook.com/tools/explorer)**.
2. Paste the token into the **Access Token** box (top right).
3. In the request bar, enter `me/accounts` → **Submit**. You should see the Utah REIA Page listed with no error.
4. Then try `17841444000419929?fields=followers_count,media_count` → Submit. You should see a follower count come back.

If both return data (not an error), the token is good.

---

## Reference — the assets this covers

| Asset | Name | ID |
|---|---|---|
| Facebook Page | Utah Real Estate Investors Association | `186123311580369` |
| Instagram (Business) | @utah.reia | `17841444000419929` |

---

## Notes

- The token **never expires** because it's a System User token set to "Never." It only stops working if the System User is deleted or its asset permissions are removed — so please leave the "Analytics Reader" system user in place.
- Keep the app owned by the **Utah REIA Business portfolio** so the token stays valid.
- This is **read-only reporting**. The dashboard never posts, comments, messages, or changes any settings.
- Questions about any step → reach David.
