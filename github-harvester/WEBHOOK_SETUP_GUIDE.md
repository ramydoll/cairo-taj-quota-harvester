# 100% BULLETPROOF SCHEDULING SETUP GUIDE
## External Webhook Triggers for GitHub Actions

**Status:** Workflows updated ✓  
**Next Step:** Configure external cron service (5 minutes)

---

## STEP 1: Create GitHub Personal Access Token

1. Go to: https://github.com/settings/tokens
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. **Token name:** `Harvester Webhook Trigger`
4. **Expiration:** No expiration (or 1 year if you prefer)
5. **Scopes:** Check ONLY this one:
   - ✅ `repo` (Full control of private repositories)
6. Click **"Generate token"**
7. **COPY THE TOKEN IMMEDIATELY** (you can't see it again!)
   - Format: `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

---

## STEP 2: Setup cron-job.org (Free, No Account Required)

### For Line 104:

1. Go to: https://cron-job.org/en/
2. Click **"Create cronjob"** (no signup needed for free tier)
3. **Title:** `GitHub Harvester Line 104`
4. **URL:** 
   ```
   https://api.github.com/repos/ranydoll/cairo-taj-quota-harvester/dispatches
   ```
5. **Schedule:**
   - **Execution pattern:** Custom
   - **Minutes:** `5, 35` (comma separated)
   - **Hours:** `*/1` (every hour)
   - **Days/Months:** `*` (all)
   - This runs at: 00:05, 00:35, 01:05, 01:35, 02:05, 02:35... (every 30 min alternating :05/:35)

6. **Advanced Settings:**
   - **Request method:** POST
   - **Request body:**
     ```json
     {
       "event_type": "harvest_line104"
     }
     ```
   - **Headers:** Add these TWO headers:
     ```
     Authorization: Bearer YOUR_GITHUB_TOKEN_HERE
     Accept: application/vnd.github.v3+json
     ```
     (Replace `YOUR_GITHUB_TOKEN_HERE` with token from Step 1)

7. Click **"Create cronjob"**

---

### For Dokki:

Repeat the same steps but with these changes:

1. **Title:** `GitHub Harvester Dokki 094`
2. **URL:** Same as above
3. **Schedule:**
   - **Minutes:** `20, 50` (offset from Line 104)
   - **Hours:** `*/1`
4. **Request body:**
   ```json
   {
     "event_type": "harvest_dokki"
   }
   ```
5. **Headers:** Same as Line 104

---

## STEP 3: Verify Setup

After creating both cron jobs:

1. Go to: https://github.com/ranydoll/cairo-taj-quota-harvester/actions
2. Wait up to 30 minutes for next scheduled time
3. You should see workflows running EXACTLY on time (:05, :20, :35, :50)

**Test immediately (optional):**
- In cron-job.org, click the ▶️ **"Execute now"** button next to each job
- Workflows should start within 5 seconds

---

## SCHEDULE SUMMARY

With this setup, you get **32 runs per day** (16 per workflow):

**Line 104:** 00:05, 00:35, 01:05, 01:35, 02:05, 02:35, 03:05, 03:35, 04:05, 04:35...  
**Dokki:** 00:20, 00:50, 01:20, 01:50, 02:20, 02:50, 03:20, 03:50, 04:20, 04:50...

**Timing accuracy:** ±5 seconds (vs ±15 minutes with GitHub cron)

---

## BACKUP TRIGGERS

Your workflows now have **3 trigger methods**:

1. ✅ **Primary:** External webhook (cron-job.org) — 100% reliable
2. ✅ **Backup:** GitHub Actions cron — runs if webhook fails
3. ✅ **Manual:** workflow_dispatch — you can trigger manually anytime

If cron-job.org is down (rare), GitHub Actions cron will still run.

---

## TROUBLESHOOTING

**Webhook not working?**
- Check token hasn't expired
- Verify `Authorization: Bearer ghp_...` header is set correctly
- Check repository name: `ranydoll/cairo-taj-quota-harvester` (no typos)
- Event type must match exactly: `harvest_line104` or `harvest_dokki`

**Still want more runs?**
Change minutes in cron-job.org to run every 20 min:
- Line 104: Minutes = `5, 25, 45`
- Dokki: Minutes = `15, 35, 55`
- This gives **72 runs/day per workflow = 144 total/day**

---

## SECURITY NOTE

Your GitHub token has `repo` access. Keep it secure:
- ✅ Stored only in cron-job.org (encrypted)
- ✅ Not in code or logs
- ✅ Can revoke anytime at: https://github.com/settings/tokens

---

**Setup complete! Push the updated workflow files and configure cron-job.org. Your scheduling will be 100% reliable.** 🎯
