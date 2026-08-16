# Bethel Tabernacle — Automatic Sermon Uploader

This is a small, free app that checks your YouTube channel every hour and, whenever
it finds a new public sermon video, automatically:

1. Builds a thumbnail (the real video frame with a title/speaker banner across the bottom).
2. Uploads it to your Wix site.
3. Adds the sermon to the Sermons page with the correct title, speaker, date, and link.
4. Marks it as the newest sermon (and un-marks whichever one used to be newest).

It skips anything with "Sunday School" in the title, and skips anything that isn't public
(so the private "When The Author Starts Writing" video, for example, stays skipped).

It runs on GitHub's free hosting, on a schedule — nobody needs to be at a computer,
and it doesn't depend on this chat being open.

**One honest limitation:** the auto-built thumbnail is a consistent template (photo +
dark banner + title + speaker), not a recreation of the varied, hand-designed thumbnails
you've been making in ChatGPT each week. If you'd rather keep sending Claude your own
ChatGPT-made image sometimes, that still works fine — the app checks whether a sermon's
already posted before adding it, so there's no duplicate or conflict either way.

---

## One-time setup

You'll need four free things: a GitHub account, a free Google Cloud API key, a Wix API
key, and four "secrets" added to the GitHub repo. It takes about 15–20 minutes total.

### Step 1 — Create the GitHub repository

1. Go to [github.com](https://github.com) and sign up for a free account if you don't
   have one.
2. Click the **+** in the top right → **New repository**.
3. Name it something like `bethel-sermon-bot`. You can make it **Private**. Click
   **Create repository**.
4. On the new repo's page, click **Add file → Upload files**, and drag in every file
   and folder from this package (including the `.github` folder — GitHub will keep its
   structure). Commit the upload.

### Step 2 — Get a free YouTube Data API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with
   the Google account tied to your YouTube channel (or any Google account).
2. Click the project dropdown at the top → **New Project**. Name it "Bethel Sermons" →
   **Create**.
3. Once it's created, make sure that project is selected, then in the top search bar
   type **YouTube Data API v3**, click it, and click **Enable**.
4. In the left sidebar go to **Credentials** → **Create Credentials** → **API key**.
5. Copy the key it gives you — this is your `YOUTUBE_API_KEY`.
6. (Recommended) Click **Restrict key**, under "API restrictions" choose **Restrict
   key**, check **YouTube Data API v3**, and **Save**. This limits what the key can be
   used for if it's ever exposed.

### Step 3 — Get your YouTube Channel ID

1. Go to [YouTube Studio](https://studio.youtube.com).
2. Click **Settings → Channel → Advanced settings**.
3. Copy the **Channel ID** shown there (starts with `UC...`). This is your
   `YOUTUBE_CHANNEL_ID`.

### Step 4 — Get a Wix API key

1. Go to [manage.wix.com/account/api-keys](https://manage.wix.com/account/api-keys)
   and sign in.
2. Click **Generate API Key**.
3. Name it something like "Sermon Bot".
4. Choose **Specific sites**, and select your Bethel Tabernacle site.
5. Under permissions, grant it access to manage **Data Collections / CMS** (so it can
   add sermons) and **Media Manager** (so it can upload thumbnails).
6. Click through to generate it, then **copy the key immediately** — Wix only shows it
   once. This is your `WIX_API_KEY`.

### Step 5 — Your Wix Site ID

You don't need to look this one up — it's:

```
9ba16ff9-3470-49e9-b4a1-8d0212d8d53d
```

This is your `WIX_SITE_ID`.

### Step 6 — Add the four secrets to GitHub

1. In your `bethel-sermon-bot` repo on GitHub, go to **Settings → Secrets and
   variables → Actions**.
2. Click **New repository secret** four times, adding:
   - `YOUTUBE_API_KEY` → the key from Step 2
   - `YOUTUBE_CHANNEL_ID` → the ID from Step 3
   - `WIX_API_KEY` → the key from Step 4
   - `WIX_SITE_ID` → `9ba16ff9-3470-49e9-b4a1-8d0212d8d53d`

### Step 7 — Turn it on and test it

1. Go to the **Actions** tab of the repo. If GitHub asks you to enable workflows,
   click to enable them.
2. Click **Check for new sermons** in the left list, then click **Run workflow** (top
   right) → **Run workflow** again to confirm.
3. Wait about 30–60 seconds, then click into the run to watch the log. It'll say
   either "No new sermons to add" (if everything's already posted) or walk through
   adding a sermon.

Once that test run looks right, you're done — it'll now check automatically, every
hour, forever.

---

## The one habit this needs from you going forward

For the app to know **who's preaching**, put a line like this somewhere in each
video's YouTube description before or right after you upload it:

```
Speaker: Jason Watkins
```

If you forget, the sermon still gets posted automatically — it'll just say "Bethel
Tabernacle" as a placeholder speaker, and you can edit that one field on the site
afterward.

Keep doing what you're already doing with **"Sunday School"** in those titles — the
app skips anything with that phrase, same as before.

---

## Troubleshooting

- **A sermon didn't show up:** Go to the repo's **Actions** tab, click the most recent
  run, and expand the log — it prints what happened in plain language.
- **Wrong speaker name:** Edit the sermon's `speaker` field directly on the site; the
  app won't touch it again once it exists.
- **Want to change how often it checks:** Edit the `cron` line in
  `.github/workflows/check-sermons.yml` — it currently runs at :15 past every hour.
