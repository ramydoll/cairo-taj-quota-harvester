const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');

puppeteer.use(StealthPlugin());

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const WE_USERNAME = process.env.WE_USERNAME;
const WE_PASSWORD = process.env.WE_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_RETRIES = 3;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function stripNum(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/,/g, '').replace(/[^\d.\-]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

async function withTimeout(promise, ms, name) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms))
  ]);
}

async function tryMethods(methods, stepName, timeout) {
  for (let i = 0; i < methods.length; i++) {
    try {
      console.log(`  [${i+1}/${methods.length}]`);
      const result = await withTimeout(methods[i](), timeout, `${stepName} M${i+1}`);
      console.log(`  ✓ Method ${i+1} SUCCESS`);
      return result;
    } catch (e) {
      console.log(`  ✗ Method ${i+1} FAILED: ${e.message}`);
      if (i === methods.length - 1) throw new Error(`${stepName} ALL METHODS FAILED`);
      await sleep(500);
    }
  }
}

async function harvestQuota() {
  console.log('🚀 STARTING...\n');
  let browser, page;

  // ── Session Cookie Helpers ─────────────────────────────────────────────────
  async function loadSavedCookies() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const doc = await res.json();
      const cookieStr = doc?.fields?.cookies?.stringValue;
      const savedAt = doc?.fields?.savedAt?.stringValue;
      if (!cookieStr || !savedAt) return null;
      // 8 hour session validity
      const age = Date.now() - new Date(savedAt).getTime();
      if (age > 8 * 60 * 60 * 1000) {
        console.log('  [SESSION] Cookies expired (>8h old), fresh login needed');
        return null;
      }
      console.log('  [SESSION] Found saved cookies (' + Math.floor(age/60000) + 'm old)');
      return JSON.parse(cookieStr);
    } catch(e) {
      console.log('  [SESSION] Could not load cookies:', e.message);
      return null;
    }
  }

  async function saveCookies(cookies) {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            cookies: { stringValue: JSON.stringify(cookies) },
            savedAt: { stringValue: new Date().toISOString() },
            line: { stringValue: '104' }
          }
        })
      });
      console.log('  [SESSION] Cookies saved ✓');
    } catch(e) {
      console.log('  [SESSION] Could not save cookies:', e.message);
    }
  }

  async function clearCookies() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            cookies: { stringValue: '' },
            savedAt: { stringValue: '' }
          }
        })
      });
      console.log('  [SESSION] Cookies cleared');
    } catch(e) {}
  }
  // ──────────────────────────────────────────────────────────────────────────

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
      protocolTimeout: 60000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => '';
      Object.defineProperty(window, 'console', { writable: false, configurable: false });
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.navigator.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    page.on('dialog', async dialog => {
      console.log('  [DIALOG] Dismissed:', dialog.message().slice(0, 80));
      await dialog.accept();
    });

    // ══════════════════════════════════════
    // STEP 0: TRY SAVED SESSION
    // ══════════════════════════════════════
    console.log('STEP 0: SESSION CHECK');
    
    let sessionValid = false;
    const savedCookies = await loadSavedCookies();
    
    if (savedCookies && savedCookies.length > 0) {
      console.log('  Trying saved session cookies...');
      await page.goto('https://my.te.eg/echannel/#/login', { waitUntil: 'networkidle2', timeout: 15000 });
      await page.setCookie(...savedCookies);
      await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(2000);
      
      const currentUrl = page.url();
      if (currentUrl.includes('accountoverview') || currentUrl.includes('account')) {
        console.log('  ✓ Session valid!\n');
        sessionValid = true;
      } else {
        console.log('  ✗ Session expired, will do fresh login\n');
      }
    } else {
      console.log('  No saved session, will do fresh login\n');
    }

    if (!sessionValid) {
      // ══════════════════════════════════════
      // STEP 1: NAVIGATE TO LOGIN
      // ══════════════════════════════════════
      console.log('STEP 1: NAVIGATE');
      
      await tryMethods([
        async () => {
          await page.goto('https://my.te.eg/echannel/#/login', { waitUntil: 'networkidle2', timeout: 15000 });
          await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 10000 });
          console.log('    networkidle2 + wait for 2 inputs');
        },
        async () => {
          await page.goto('https://my.te.eg/echannel/#/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(5000);
          console.log('    domcontentloaded + 5s sleep');
        }
      ], 'NAVIGATE', 20000);

      console.log('  URL:', page.url());
      await sleep(randomDelay(5000, 8000));

      // ══════════════════════════════════════
      // STEP 2: SERVICE NUMBER
      // ══════════════════════════════════════
      console.log('STEP 2: SERVICE NUMBER (USERNAME)');
      
      await tryMethods([
        async () => {
          await page.focus('#login_loginid_input_01');
          await sleep(1000);
          await page.type('#login_loginid_input_01', WE_USERNAME, { delay: randomDelay(80, 150) });
          await sleep(1000);
          console.log('    focus + type');
        },
        async () => {
          const el = await page.$('#login_loginid_input_01');
          if (!el) throw new Error('ID not found');
          await el.click();
          await sleep(1000);
          await el.type(WE_USERNAME, { delay: randomDelay(80, 150) });
          await sleep(1000);
          console.log('    $ find + click + type');
        }
      ], 'SERVICE NUMBER', 15000);

      console.log('  [OK] Service number entered');
      await sleep(randomDelay(5000, 8000));

      // ══════════════════════════════════════
      // STEP 3: DROPDOWN
      // ══════════════════════════════════════
      console.log('STEP 3: DROPDOWN');
      
      await tryMethods([
        async () => {
          await page.waitForFunction(() => !!document.querySelector('.ant-select-selector'), { timeout: 10000 });
          await sleep(500);
          await page.click('.ant-select-selector');
          await sleep(1500);
          await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.ant-select-item-option, li'));
            const inet = items.find(i => i.textContent?.toLowerCase().includes('internet'));
            if (inet) inet.click();
          });
          console.log('    waitForFunction + click');
        },
        async () => {
          await page.click('.ant-select');
          await sleep(1500);
          await page.keyboard.press('ArrowDown');
          await sleep(300);
          await page.keyboard.press('Enter');
          console.log('    click + arrow + enter');
        }
      ], 'DROPDOWN', 15000);

      console.log('  [OK] Dropdown done');
      await sleep(randomDelay(5000, 8000));

      // ══════════════════════════════════════
      // STEP 4: PASSWORD
      // ══════════════════════════════════════
      console.log('STEP 4: PASSWORD');
      
      await tryMethods([
        async () => {
          await page.focus('#login_password_input_01');
          await sleep(1000);
          await page.type('#login_password_input_01', WE_PASSWORD, { delay: randomDelay(80, 150) });
          await sleep(1000);
          console.log('    focus + type');
        },
        async () => {
          const el = await page.$('#login_password_input_01');
          if (!el) throw new Error('ID not found');
          await el.click();
          await sleep(1000);
          await el.type(WE_PASSWORD, { delay: randomDelay(80, 150) });
          await sleep(1000);
          console.log('    $ find + click + type');
        }
      ], 'PASSWORD', 15000);

      console.log('  [OK] Password done');
      await sleep(randomDelay(5000, 8000));

      // ══════════════════════════════════════
      // STEP 5: SUBMIT & CHECK FOR CAPTCHA/T&C
      // ══════════════════════════════════════
      console.log('STEP 5: SUBMIT');
      
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent?.toLowerCase().includes('login'));
        if (btn) btn.click();
      });
      
      console.log('  Waiting for login result...');
      await sleep(1000);

      // Check what happened after submit - could be: captcha, T&C, or success
      let postLoginState = 'unknown';
      
      for (let tick = 0; tick < 30; tick++) {
        await sleep(1000);
        
        const currentUrl = page.url();
        if (!currentUrl.includes('login')) {
          postLoginState = 'navigated';
          console.log('  ✓ Login successful!\n');
          break;
        }

        const pageState = await page.evaluate(() => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          const hasCaptcha = !!modal;
          const hasTnC = document.body.innerText.includes('Terms') && document.body.innerText.includes('Conditions');
          return { hasCaptcha, hasTnC };
        }).catch(() => ({ hasCaptcha: false, hasTnC: false }));

        if (pageState.hasCaptcha) {
          postLoginState = 'captcha';
          console.log('  [CAPTCHA] Modal detected');
          break;
        }
        
        if (pageState.hasTnC) {
          postLoginState = 'tnc';
          console.log('  [T&C] Terms modal detected');
          break;
        }
      }

      // Handle T&C if present
      if (postLoginState === 'tnc') {
        console.log('  Accepting Terms & Conditions...');
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const acceptBtn = btns.find(b => /accept|agree|confirm/i.test(b.textContent));
          if (acceptBtn) acceptBtn.click();
        });
        await sleep(3000);
        
        // Check again for captcha or success
        const currentUrl = page.url();
        if (!currentUrl.includes('login')) {
          postLoginState = 'navigated';
          console.log('  ✓ Login successful after T&C!\n');
        } else {
          const hasCaptcha = await page.evaluate(() => 
            !!document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]')
          );
          if (hasCaptcha) postLoginState = 'captcha';
        }
      }

      // ══════════════════════════════════════
      // ULTIMATE CAPTCHA ENGINE
      // 18 filters | colorOnly priority | 1-digit boost | top-2 candidates
      // ══════════════════════════════════════
      if (postLoginState === 'captcha') {
        console.log('  [CAPTCHA] ULTIMATE Engine v5 starting...\n');

        // Helper: Find captcha image with multiple methods
        async function getCaptchaImage() {
          // Method 1: Direct image element
          try {
            const imgSrc = await page.evaluate(() => {
              const modal = document.querySelector('.ant-modal-content, .ant-modal');
              if (!modal) return null;
              const imgs = Array.from(modal.querySelectorAll('img'));
              if (imgs.length === 0) return null;
              const captchaImg = imgs.find(img => {
                const r = img.getBoundingClientRect();
                return r.width > 80 && r.height > 25;
              }) || imgs[0];
              return captchaImg.src || captchaImg.getAttribute('src');
            });
            
            if (imgSrc && imgSrc.startsWith('data:image')) {
              return imgSrc;
            }
            
            if (imgSrc && imgSrc.startsWith('http')) {
              // Fetch with cookies
              const cookies = await page.cookies();
              const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
              const resp = await fetch(imgSrc, {
                headers: {
                  'Cookie': cookieStr,
                  'Referer': 'https://my.te.eg/',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
              });
              if (resp.ok) {
                const buf = await resp.buffer();
                return 'data:image/png;base64,' + buf.toString('base64');
              }
            }
          } catch(e) {}
          
          // Method 2: Screenshot modal
          try {
            const modalElement = await page.$('.ant-modal-content, .ant-modal');
            if (modalElement) {
              const screenshot = await modalElement.screenshot({ encoding: 'base64' });
              return 'data:image/png;base64,' + screenshot;
            }
          } catch(e) {}
          
          return null;
        }

        // Helper: Apply canvas filter
        async function applyFilter(base64Data, filterName) {
          return await page.evaluate((data, filter) => {
            return new Promise(resolve => {
              const img = new Image();
              img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width * 2;
                canvas.height = img.height * 2;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const d = imageData.data;

                // Apply filter
                switch(filter) {
                  case 'colorOnly':
                    for (let i = 0; i < d.length; i += 4) {
                      const r = d[i], g = d[i+1], b = d[i+2];
                      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                      const colorfulness = Math.max(Math.abs(r-g), Math.abs(g-b), Math.abs(b-r));
                      d[i] = d[i+1] = d[i+2] = colorfulness > 30 ? 0 : 255;
                    }
                    break;
                  case 'warmColors':
                    for (let i = 0; i < d.length; i += 4) {
                      const isWarm = d[i] > d[i+2] + 20;
                      d[i] = d[i+1] = d[i+2] = isWarm ? 0 : 255;
                    }
                    break;
                  case 'channelDivide':
                    for (let i = 0; i < d.length; i += 4) {
                      const r = d[i], g = d[i+1], b = d[i+2];
                      const bw = ((r / Math.max(b, 1)) > 1.2 || (g / Math.max(b, 1)) > 1.2) ? 0 : 255;
                      d[i] = d[i+1] = d[i+2] = bw;
                    }
                    break;
                  case 'blueInverter':
                    for (let i = 0; i < d.length; i += 4) {
                      const isDark = d[i+2] < 100;
                      d[i] = d[i+1] = d[i+2] = isDark ? 255 : 0;
                    }
                    break;
                  case 'greenSuppress':
                    for (let i = 0; i < d.length; i += 4) {
                      d[i+1] = Math.min(d[i+1], 100);
                      const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
                      d[i] = d[i+1] = d[i+2] = gray < 128 ? 0 : 255;
                    }
                    break;
                  case 'redBlueBalance':
                    for (let i = 0; i < d.length; i += 4) {
                      const diff = Math.abs(d[i] - d[i+2]);
                      d[i] = d[i+1] = d[i+2] = diff > 40 ? 0 : 255;
                    }
                    break;
                  case 'darkColor':
                    for (let i = 0; i < d.length; i += 4) {
                      const brightness = (d[i] + d[i+1] + d[i+2]) / 3;
                      d[i] = d[i+1] = d[i+2] = brightness < 100 ? 0 : 255;
                    }
                    break;
                  case 'satStrict':
                    for (let i = 0; i < d.length; i += 4) {
                      const max = Math.max(d[i], d[i+1], d[i+2]);
                      const min = Math.min(d[i], d[i+1], d[i+2]);
                      const sat = max === 0 ? 0 : (max - min) / max;
                      d[i] = d[i+1] = d[i+2] = sat > 0.3 ? 0 : 255;
                    }
                    break;
                  default:
                    const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
                    d[i] = d[i+1] = d[i+2] = gray < 128 ? 0 : 255;
                }

                ctx.putImageData(imageData, 0, 0);
                resolve(canvas.toDataURL());
              };
              img.src = data;
            });
          }, base64Data, filterName);
        }

        // Helper: OCR with multiple PSM modes
        async function ocrRead(imageData) {
          const results = new Set();
          const whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
          
          for (const psm of ['8', '7', '13', '6']) {
            try {
              const { data } = await Tesseract.recognize(imageData, 'eng', {
                tessedit_char_whitelist: whitelist,
                tessedit_pageseg_mode: psm,
                preserve_interword_spaces: '0'
              });
              const text = data.text.replace(/[^A-Za-z0-9]/g, '').trim();
              if (text.length >= 5 && text.length <= 7) {
                results.add(text);
              }
            } catch(e) {}
          }
          
          return Array.from(results);
        }

        // Helper: Submit captcha answer
        async function submitCaptcha(answer) {
          await page.evaluate((ans) => {
            const modal = document.querySelector('.ant-modal-content, .ant-modal');
            if (!modal) return;
            const inp = modal.querySelector('input.ant-input, input[type="text"], input');
            if (!inp) return;
            
            inp.focus();
            inp.click();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, '');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            setter.call(inp, ans);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            
            const btns = Array.from(modal.querySelectorAll('button'));
            const btn = btns.find(b => /ok|confirm|submit/i.test(b.textContent)) || btns[btns.length - 1];
            if (btn) btn.click();
          }, answer);
          
          await sleep(2000);
          
          // Check if still on login or modal closed
          const currentUrl = page.url();
          if (!currentUrl.includes('login')) return true;
          
          const modalStillOpen = await page.evaluate(() => 
            !!document.querySelector('.ant-modal-content, .ant-modal')
          );
          
          return !modalStillOpen;
        }

        const FILTERS = [
          'colorOnly', 'warmColors', 'channelDivide', 'blueInverter',
          'greenSuppress', 'redBlueBalance', 'darkColor', 'satStrict',
          'colorDeep', 'colorBroad', 'colorMid', 'colorPure',
          'colorHue', 'thresh110Color', 'thresh150Color', 'hueSplit',
          'dilateColor', 'adaptiveColor'
        ];

        let captchaSolved = false;

        for (let round = 1; round <= 12 && !captchaSolved; round++) {
          console.log(`  -- Round ${round} / 12 --`);

          // Get image
          const imageData = await getCaptchaImage();
          if (!imageData) {
            console.log('    ! No captcha image found');
            await sleep(2000);
            continue;
          }

          // Collect candidates with weighted voting
          const candidates = new Map();
          
          // Run all filters
          for (const filter of FILTERS) {
            try {
              const filtered = await applyFilter(imageData, filter);
              const texts = await ocrRead(filtered);
              
              const weight = filter === 'colorOnly' ? 2 : 
                           (filter.startsWith('color') ? 1.5 : 1);
              
              texts.forEach(text => {
                const current = candidates.get(text) || 0;
                candidates.set(text, current + weight);
              });
              
              if (texts.length > 0) {
                console.log(`    [${filter}] OCR: ${JSON.stringify(texts)}`);
              }
            } catch(e) {}
          }

          if (candidates.size === 0) {
            console.log('    ! No valid candidates');
            continue;
          }

          // SMART VOTING: Boost results with exactly 1 digit (WE captcha pattern)
          const smartSort = [...candidates.entries()].map(([text, votes]) => {
            const digitCount = (text.match(/\d/g) || []).length;
            const hasOneDigit = digitCount === 1;
            const smartVotes = hasOneDigit ? votes * 1.3 : votes;
            return [text, votes, smartVotes, hasOneDigit];
          }).sort((a, b) => b[2] - a[2]);

          console.log('    [VOTING]:');
          smartSort.forEach(([text, origVotes, smartVotes, has1digit]) => {
            console.log(`      "${text}" = ${origVotes} votes${has1digit ? ' ⭐ +30% = ' + smartVotes.toFixed(1) : ''}`);
          });

          const best = smartSort[0];
          const secondBest = smartSort.length > 1 ? smartSort[1] : null;

          console.log(`    [BEST] "${best[0]}" (${best[2].toFixed(1)} smart votes)`);
          
          // Try top 2 if close (within 60%)
          const attemptsToTry = [best[0]];
          if (secondBest && secondBest[2] >= best[2] * 0.6) {
            attemptsToTry.push(secondBest[0]);
            console.log(`    [#2] "${secondBest[0]}" (${secondBest[2].toFixed(1)}) - close enough, will try`);
          }

          // Try each candidate with case variants
          for (const candidate of attemptsToTry) {
            const variants = [candidate, candidate.toUpperCase(), candidate.toLowerCase()];
            for (const variant of [...new Set(variants)]) {
              console.log(`    -> Trying: ${variant}`);
              captchaSolved = await submitCaptcha(variant);
              if (captchaSolved) {
                console.log(`  >>> CAPTCHA SOLVED with "${variant}"! <<<\n`);
                break;
              }
              console.log(`    X Wrong`);
              await sleep(1500);
            }
            if (captchaSolved) break;
          }

          if (!captchaSolved) {
            console.log('    All attempts failed, next round...');
            await sleep(2000);
          }
        }

        if (!captchaSolved) {
          throw new Error('Captcha unsolvable after 12 rounds');
        }
      }

      if (postLoginState === 'unknown') {
        throw new Error('Login stuck - no navigation, captcha, or T&C detected');
      }

      // Save session cookies
      try {
        const cookies = await page.cookies();
        const relevantCookies = cookies.filter(c => c.domain.includes('te.eg'));
        if (relevantCookies.length > 0) {
          await saveCookies(relevantCookies);
        }
      } catch(e) {
        console.log('  [SESSION] Could not save cookies:', e.message);
      }
    }

    // ══════════════════════════════════════
    // STEP 6: EXTRACT DATA
    // ══════════════════════════════════════
    console.log('STEP 6: EXTRACT');
    
    await sleep(3000);

    const data = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span, div, p'));
      let remaining = null, used = null, balance = null, plan = null;
      
      function isNumericText(t) {
        if (!t) return false;
        const s = t.replace(/,/g, '').trim();
        return /^\d+(\.\d+)?$/.test(s) && !s.startsWith('0237');
      }
      
      for (let i = 0; i < spans.length; i++) {
        const t = spans[i].innerText?.trim();
        if (!t || t.length > 100) continue;
        
        if (t === 'Remaining') {
          for (let b = 1; b <= 3; b++) {
            const c = spans[i-b]?.innerText?.trim();
            if (isNumericText(c)) { remaining = c; break; }
          }
        }
        
        if (t === 'Used') {
          for (let b = 1; b <= 3; b++) {
            const c = spans[i-b]?.innerText?.trim();
            if (isNumericText(c)) { used = c; break; }
          }
        }
        
        if (t === 'Current Balance') {
          for (let f = 1; f <= 5; f++) {
            const c = spans[i+f]?.innerText?.trim();
            if (isNumericText(c)) { balance = c; break; }
          }
        }
        
        if (t.includes('GB') && t.toLowerCase().includes('speed')) {
          plan = t;
        }
      }
      
      if (!remaining) throw new Error('No remaining quota found');
      
      return {
        remaining: remaining,
        used: used || '0',
        balance: balance || '0',
        plan: plan || 'Unknown'
      };
    });

    const parsed = {
      remaining: stripNum(data.remaining),
      used: stripNum(data.used) || 0,
      balance: stripNum(data.balance) || 0,
      plan: data.plan
    };

    if (parsed.remaining === null) {
      throw new Error('Failed to parse remaining quota');
    }

    console.log('  Remaining:', parsed.remaining, 'GB');
    console.log('  Used:', parsed.used, 'GB');
    console.log('  Balance:', parsed.balance, 'EGP');
    console.log('  Plan:', parsed.plan, '\n');

    // ══════════════════════════════════════
    // STEP 7: UPLOAD TO FIRESTORE
    // ══════════════════════════════════════
    console.log('STEP 7: FIRESTORE');
    
    const now = new Date().toISOString();
    const fields = {
      '104': {
        mapValue: {
          fields: {
            quota: { doubleValue: parsed.remaining },
            maxQuota: { doubleValue: parsed.remaining + parsed.used },
            balance: { doubleValue: parsed.balance },
            used: { doubleValue: parsed.used },
            plan: { stringValue: parsed.plan },
            updatedAt: { stringValue: now },
            updatedBy: { stringValue: 'GitHub Actions ⚡' },
            status: { stringValue: 'success' }
          }
        }
      },
      lastUpdate: { stringValue: now }
    };

    const mask = 'updateMask.fieldPaths=%60104%60&updateMask.fieldPaths=lastUpdate';
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}&${mask}`;
    
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    if (!res.ok) {
      throw new Error(`Firestore upload failed: HTTP ${res.status}`);
    }

    console.log('  ✓ Uploaded to Firestore!\n');

    // ══════════════════════════════════════
    // STEP 8: TELEGRAM NOTIFICATION
    // ══════════════════════════════════════
    console.log('STEP 8: TELEGRAM');
    
    const message = `🎉 Line 104 Quota Updated\\n\\n📊 Remaining: *${parsed.remaining} GB*\\nUsed: ${parsed.used} GB\\nBalance: ${parsed.balance} EGP\\nPlan: ${parsed.plan}\\n\\n⏰ ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })}`;
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });

    console.log('  ✓ Telegram notification sent!\n');

  } catch (error) {
    console.error('\\n❌ ERROR:', error.message);
    
    // Take screenshot on error
    if (page) {
      try {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        console.log('Screenshot length:', screenshot.length);
        
        const pageState = await page.evaluate(() => ({
          url: window.location.href,
          inputs: Array.from(document.querySelectorAll('input')).map(inp => ({
            id: inp.id,
            type: inp.type,
            visible: inp.offsetParent !== null
          })),
          bodyLen: document.body.innerHTML.length
        }));
        console.log('Page state:', JSON.stringify(pageState));
      } catch(e) {}
    }
    
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`\\n${'═'.repeat(50)}\\nATTEMPT ${attempt}/${MAX_RETRIES}\\n${'═'.repeat(50)}\\n`);
      await harvestQuota();
      console.log('\\n🎉 COMPLETE!');
      process.exit(0);
    } catch (error) {
      console.error(`\\nAttempt ${attempt} failed: ${error.message}`);
      
      if (attempt < MAX_RETRIES) {
        const delay = randomDelay(30000, 45000);
        console.log(`Retrying in ${Math.floor(delay/1000)}s...`);
        await sleep(delay);
      } else {
        console.error('\\n💀 ALL ATTEMPTS FAILED');
        process.exit(1);
      }
    }
  }
}

main();
