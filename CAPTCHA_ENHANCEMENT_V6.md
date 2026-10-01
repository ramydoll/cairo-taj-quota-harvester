# Captcha Engine Enhancement V6 - 2026-08-28

## Objective
Make captcha solving **smarter and more aggressive** by focusing on best-performing filters and implementing intelligent refresh strategy.

---

## Changes Made (Dokki File Only)

### 1. **Removed Poor-Performing Filters (3 removed)**
Based on actual logs showing these filters returned empty results or wrong text:

**REMOVED:**
- `colorWide` - returned empty `[]`
- `green` - returned empty `[]`
- `notGray` - low accuracy, contributed to wrong results
- `thresh128` - returned empty `[]`
- `rBoost` - returned empty `[]`

---

### 2. **Added 3 New High-Quality Color Filters**
Since `colorOnly` was the **best performer**, added 3 variants that are similar but with slightly different thresholds:

**NEW FILTERS:**
- `colorTight` - `sat > 0.30 && lum < 210 && lum > 25` (tighter, more precise)
- `colorMid` - `sat > 0.28 && lum < 215 && lum > 22` (balanced middle ground)
- `colorSoft` - `sat > 0.22 && lum < 225 && lum > 18` (softer, catches more)

These give **more votes to color-based detection** (which works best for WE captchas).

---

### 3. **Enhanced Voting Weights**
Old system:
- `colorOnly` = 3 votes
- All others = 1 vote

**New system:**
- `colorOnly` = **3 votes** (best performer)
- `colorTight` = **2 votes** (new high-confidence variant)
- `colorMid` = **2 votes** (new balanced variant)
- `colorSoft` = **2 votes** (new softer variant)
- All others = 1 vote

**Result:** Color-based filters now contribute **9 votes** instead of 3 → much higher confidence when they agree.

---

### 4. **Smart Refresh Strategy**

#### Old Behavior (50% threshold, 3 max refreshes):
```
If confidence < 50% → refresh (max 3 times)
```
Problem: Only 3 attempts wasn't enough to find an easy captcha.

#### **New Behavior (75% threshold, 10 max refreshes):**
```
1. Run all filters on captcha image
2. Calculate confidence based on weighted votes
3. IF confidence >= 75% → submit answer immediately
4. IF confidence < 75% → click purple refresh button, get NEW captcha, repeat
5. Max 10 refresh attempts (enough to find an easy one)
```

**Benefits:**
- Don't waste time on hard captchas (confidence < 75%)
- Keep refreshing until we get an **easy, readable** captcha
- 10 attempts = much higher chance of finding a clear image
- Only submit when confidence is high

---

### 5. **Updated Filter List**

**Before (18 filters):**
```
colorOnly, colorStrong, colorWide, red, redLoose, blue, green, notGray,
dark, dark2, dark3, midtone, contrast, thresh128, thresh160,
rBoost, gBoost, satBoost
```

**After (15 filters - focused quality over quantity):**
```
colorOnly, colorTight, colorMid, colorSoft,    ← 4 color variants (9 votes total)
colorStrong, red, redLoose, blue,              ← existing color filters
dark, dark2, dark3, midtone,                   ← luminance filters
contrast, thresh160,                            ← contrast filters
gBoost, satBoost                                ← channel boost filters
```

---

## Expected Improvements

### Scenario 1: Easy Captcha (First Try)
```
Refresh #1: Confidence = 85% → SUBMIT immediately ✅
Result: Fast success, no wasted time
```

### Scenario 2: Hard Captcha (Multiple Refreshes)
```
Refresh #1: Confidence = 55% → refresh
Refresh #2: Confidence = 62% → refresh
Refresh #3: Confidence = 48% → refresh
Refresh #4: Confidence = 78% → SUBMIT ✅
Result: Found easy captcha after 4 tries
```

### Scenario 3: All Hard Captchas (Max Refreshes)
```
Refresh #1-9: All < 75%
Refresh #10: Confidence = 68% → submit anyway (max reached)
Result: Best effort after exhausting refreshes
```

---

## Technical Details

### Confidence Calculation
```javascript
confidence = (maxWeight / totalVotesPossible) * 100

Example:
- colorOnly votes for "ABCD5": 3 votes
- colorTight votes for "ABCD5": 2 votes
- colorMid votes for "ABCD5": 2 votes
- colorSoft votes for "ABCD5": 2 votes
- Total for "ABCD5": 9 votes
- Total possible: 9 (if all 4 agreed perfectly)
- Confidence = (9 / 9) * 100 = 100% ✅
```

### Purple IMG Refresh Button
Already working from previous fix:
1. Finds small icon-sized IMG (10-60px)
2. Clicks it to refresh captcha
3. Waits 3s for new image to load
4. Repeats OCR analysis

---

## Files Modified
- `github-harvester/harvester-dokki.js` (Dokki only, as requested)

---

## Testing Instructions

1. Push changes
2. Run "Cloud Quota Harvester - Dokki" workflow
3. If captcha appears, watch logs for:
   - Multiple filters voting for same result
   - High confidence % (75%+)
   - Or multiple refresh attempts until high confidence
4. Expected: Much higher success rate on captcha solving

---

## Future Enhancements (if needed)

1. **Add more color variants** if 75% threshold is too strict
2. **Lower threshold to 70%** if we're refreshing too many times
3. **Increase max refreshes to 15** if WE has many hard captchas
4. **Apply same changes to line 104** once proven successful on Dokki
