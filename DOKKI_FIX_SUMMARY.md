# Dokki Fix Summary - 2026-08-28

## Root Cause
Dokki workflow was using **Chrome 119** (14 months old) while Line 104 was using **Chrome stable** (v154, latest). WE's anti-bot system flagged the outdated browser as suspicious, causing:
- Attempts 1-2: Silent blocking (stuck on login page)
- Attempt 3: Impossible captcha

## Fixes Applied

### 1. Workflow Files - Chrome Version Standardization
**Changed in ALL 4 workflow files:**
- `harvester-dokki.yml` (production)
- `harvester.yml` (production)
- `harvester-dokki-test.yml` (test)
- `harvester-test.yml` (test)

**Before:**
```yaml
chrome-version: 119  # Only in Dokki
```

**After:**
```yaml
# CRITICAL: Always use 'stable' to match production fingerprint
# Using old versions (e.g. 119) triggers WE's anti-bot detection
chrome-version: stable
```

### 2. Script Files - Chrome Path Consistency
**Changed:** `harvester-dokki.js`

**Before (used different binary):**
```javascript
const fs = require('fs');
const candidatePaths = [...];
const chromiumPath = candidatePaths.find(p => p && fs.existsSync(p));
// This picked /usr/bin/chromium-browser instead of CHROME_PATH
```

**After (matches 104 exactly):**
```javascript
const chromiumPath = process.env.CHROME_PATH ||
  '/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome' ||
  '/usr/bin/chromium-browser' ||
  '/usr/bin/chromium' ||
  '/usr/bin/google-chrome-stable';
// Now uses CHROME_PATH first, same as Line 104
```

## Why This Works

### Before:
| | Line 104 | Dokki |
|---|---|---|
| Chrome Version | 154 (stable) | 119 (old) |
| Browser Binary | From CHROME_PATH | /usr/bin/chromium-browser |
| Fingerprint | Modern, legitimate | Old, suspicious |
| WE Response | ✅ Login success | ❌ Silent block / impossible captcha |

### After:
| | Line 104 | Dokki |
|---|---|---|
| Chrome Version | 154 (stable) | 154 (stable) ✅ |
| Browser Binary | From CHROME_PATH | From CHROME_PATH ✅ |
| Fingerprint | Modern, legitimate | **IDENTICAL** ✅ |
| WE Response | ✅ Login success | ✅ **Should work now** |

## Files Changed
1. `.github/workflows/harvester-dokki.yml` - Chrome stable + warning comment
2. `.github/workflows/harvester.yml` - Warning comment added
3. `.github/workflows/harvester-dokki-test.yml` - Warning comment added
4. `.github/workflows/harvester-test.yml` - Warning comment added
5. `github-harvester/harvester-dokki.js` - Reverted to same path logic as 104

## Testing Instructions
1. Push all changes
2. Run "Cloud Quota Harvester - Dokki (Smart Captcha TEST)" workflow manually
3. Expected result: Clean login without captcha, just like Line 104

## Prevention
- All workflow files now have inline comments warning against using old Chrome versions
- Both scripts use identical Chrome path logic
- Any future changes to one should be mirrored to the other
