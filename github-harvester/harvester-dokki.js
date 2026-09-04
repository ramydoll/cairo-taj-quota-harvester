const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch');

puppeteer.use(StealthPlugin());

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const WE_USERNAME = process.env.DOKKI_USERNAME;
const WE_PASSWORD = process.env.DOKKI_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID; // Group chat for colleague
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
  const RETRIES_PER_METHOD = 2; // Each method tries twice before moving to next
  
  for (let i = 0; i < methods.length; i++) {
    let methodSuccess = false;
    
    for (let attempt = 1; attempt <= RETRIES_PER_METHOD; attempt++) {
      try {
        if (attempt === 1) {
          console.log(`  [${i+1}/${methods.length}]`);
        } else {
          console.log(`  [${i+1}/${methods.length}] retry ${attempt}/${RETRIES_PER_METHOD}`);
        }
        
        const result = await withTimeout(methods[i](), timeout, `${stepName} M${i+1}`);
        console.log(`  ✓ Method ${i+1} SUCCESS${attempt > 1 ? ` (on attempt ${attempt})` : ''}`);
        return result;
        
      } catch (e) {
        console.log(`  ✗ Method ${i+1} attempt ${attempt} FAILED: ${e.message}`);
        
        if (attempt < RETRIES_PER_METHOD) {
          // Retry this method after progressive delay
          const retryDelay = 2000 + (attempt * 2000); // 2s, 4s, 6s...
          console.log(`    ↻ Retrying method ${i+1} in ${retryDelay/1000}s...`);
          await sleep(retryDelay);
        } else {
          // All retries exhausted for this method, move to next
          if (i === methods.length - 1) {
            throw new Error(`${stepName} ALL METHODS FAILED (each tried ${RETRIES_PER_METHOD}x)`);
          }
          console.log(`    → Moving to next method...`);
          await sleep(500);
          break;
        }
      }
    }
  }
}

async function harvestQuota() {
  console.log('🚀 STARTING...\n');
  let browser, page;

  // ── Session Cookie Helpers (Dokki) ────────────────────────────────────────
  async function loadSavedCookies() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const doc = await res.json();
      const cookieStr = doc?.fields?.cookies?.stringValue;
      const savedAt = doc?.fields?.savedAt?.stringValue;
      if (!cookieStr || !savedAt) return null;
      const age = Date.now() - new Date(savedAt).getTime();
      if (age > 4 * 60 * 60 * 1000) { console.log('  [SESSION] Cookies expired (>4h old), fresh login'); return null; }
      console.log('  [SESSION] Found saved cookies (' + Math.floor(age/60000) + 'm old)');
      return JSON.parse(cookieStr);
    } catch(e) { console.log('  [SESSION] Could not load cookies:', e.message); return null; }
  }

  async function saveCookies(cookies) {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      await fetch(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          cookies:  { stringValue: JSON.stringify(cookies) },
          savedAt:  { stringValue: new Date().toISOString() },
          line:     { stringValue: 'dokki' }
        }})
      });
      console.log('  [SESSION] Cookies saved to Firestore ✓');
    } catch(e) { console.log('  [SESSION] Could not save cookies:', e.message); }
  }

  async function clearCookies() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { cookies: { stringValue: '' }, savedAt: { stringValue: '' } }})
      });
      console.log('  [SESSION] Cookies cleared');
    } catch(e) {}
  }
  // ──────────────────────────────────────────────────────────────────────────

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome-stable',
      protocolTimeout: 60000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      // Kill alert/confirm/prompt before site JS runs - prevents "Prohibit use of console" dialog
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => '';
      
      // Protect console from being overridden by site
      Object.defineProperty(window, 'console', {
        writable: false,
        configurable: false
      });
      
      // Existing stealth
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.navigator.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    page.on('dialog', async dialog => {
      console.log('  Dialog dismissed:', dialog.message().slice(0, 80));
      await dialog.accept();
    });

    // ══════════════════════════════════════
    // STEP 0: TRY SAVED SESSION COOKIES
    // ══════════════════════════════════════
    console.log('STEP 0: SESSION CHECK');
    let sessionValid = false;
    const savedCookies = await loadSavedCookies();
    if (savedCookies && savedCookies.length > 0) {
      try {
        console.log('  Trying saved session cookies...');
        await page.setCookie(...savedCookies);
        await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 20000 });
        await sleep(3000);
        const url = page.url();
        const isLoggedIn = !url.includes('login') && url.includes('account');
        if (isLoggedIn) {
          sessionValid = true;
          console.log('  ✓ Session still valid! Skipping login entirely.\n');
        } else {
          console.log('  ✗ Session expired, clearing and doing fresh login');
          await clearCookies();
        }
      } catch(e) {
        console.log('  ✗ Session check failed:', e.message);
        await clearCookies();
      }
    } else {
      console.log('  No saved session, will do fresh login\n');
    }

    // ══════════════════════════════════════
    console.log('STEP 1: NAVIGATE');
    // ══════════════════════════════════════
    if (!sessionValid) {
    await tryMethods([
      // M1: EXACT same as working local harvester
      async () => {
        await page.goto('https://my.te.eg/echannel/', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 15000 });
        console.log('    networkidle2 + wait for 2 inputs (local harvester method)');
      },
      // M2: domcontentloaded + wait for 2 inputs
      async () => {
        await page.goto('https://my.te.eg/echannel/', { waitUntil: 'domcontentloaded', timeout: 40000 });
        await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 20000 });
        console.log('    domcontentloaded + wait for 2 inputs');
      },
      // M3: load + wait for 2 inputs
      async () => {
        await page.goto('https://my.te.eg/echannel/', { waitUntil: 'load', timeout: 40000 });
        await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 20000 });
        console.log('    load + wait for 2 inputs');
      },
      // M4: no wait + long sleep + check inputs
      async () => {
        await page.goto('https://my.te.eg/echannel/', { timeout: 40000 });
        await sleep(15000);
        const count = await page.evaluate(() => document.querySelectorAll('input').length);
        if (count < 1) throw new Error(`Only ${count} inputs found`);
        console.log(`    no wait + 15s sleep, found ${count} inputs`);
      },
      // M5: domcontentloaded + very long sleep
      async () => {
        await page.goto('https://my.te.eg/echannel/', { waitUntil: 'domcontentloaded', timeout: 40000 });
        await sleep(20000);
        console.log('    domcontentloaded + 20s sleep');
      }
    ], 'NAVIGATE', 55000);

    console.log('  URL:', page.url());

    // Dump diagnostics BEFORE username step
    console.log('\n  --- FORM DIAGNOSTICS ---');
    const diag = await withTimeout(page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return {
        url: window.location.href,
        inputCount: inputs.length,
        inputs: inputs.map((inp, i) => ({
          i, id: inp.id, name: inp.name, type: inp.type,
          placeholder: inp.placeholder, visible: inp.offsetParent !== null,
          value: inp.value
        })),
        hasAntSelect: !!document.querySelector('.ant-select'),
        hasAntInput: !!document.querySelector('.ant-input'),
        bodyLen: document.body.innerHTML.length
      };
    }), 10000, 'diagnostics');
    console.log('  URL:', diag.url);
    console.log('  Inputs found:', diag.inputCount);
    console.log('  .ant-select:', diag.hasAntSelect, ' .ant-input:', diag.hasAntInput);
    diag.inputs.forEach(inp => console.log(`    [${inp.i}] id="${inp.id}" type="${inp.type}" placeholder="${inp.placeholder}" visible=${inp.visible}`));
    console.log('  --- END DIAGNOSTICS ---\n');

    // Human-like pause before typing
    const delay1 = randomDelay(5000, 8000);
    console.log('  [HUMAN] pause', delay1, 'ms');
    await sleep(delay1);

    // ======================================
    console.log('STEP 2: SERVICE NUMBER (USERNAME)');
    // ======================================
    await tryMethods([
      // M1: EXACT same as working local harvester
      async () => {
        await page.focus('#login_loginid_input_01');
        await sleep(3000);
        await page.type('#login_loginid_input_01', WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    focus + type (local harvester method)');
      },
      // M2: $ find + click + type
      async () => {
        const el = await page.$('#login_loginid_input_01');
        if (!el) throw new Error('ID not found');
        await el.click(); await sleep(3000);
        await el.type(WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    $ find + click + type');
      },
      // M3: .ant-input class
      async () => {
        const els = await page.$$('.ant-input');
        if (!els.length) throw new Error('no .ant-input');
        await els[0].click(); await sleep(3000);
        await els[0].type(WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    .ant-input class');
      },
      // M4: input[type=text]
      async () => {
        const els = await page.$$('input[type="text"]');
        if (!els.length) throw new Error('no text inputs');
        await els[0].click(); await sleep(3000);
        await els[0].type(WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    input[type=text]');
      },
      // M5: DOM evaluate with React-compatible events
      async () => {
        const ok = await page.evaluate((u) => {
          const inp = document.querySelector('#login_loginid_input_01') ||
                      document.querySelector('.ant-input') ||
                      document.querySelector('input[type="text"]') ||
                      document.querySelector('input:not([type="password"]):not([type="hidden"])');
          if (!inp) return false;
          inp.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(inp, u);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, WE_USERNAME);
        if (!ok) throw new Error('DOM set failed');
        await sleep(3000);
        console.log('    DOM native setter + React events');
      },
      // M6: loop all inputs
      async () => {
        const all = await page.$$('input');
        if (!all.length) throw new Error('no inputs at all');
        for (let i = 0; i < all.length; i++) {
          const info = await all[i].evaluate(el => ({
            type: el.type, visible: el.offsetParent !== null, id: el.id
          }));
          console.log(`    input[${i}] id="${info.id}" type="${info.type}" visible=${info.visible}`);
          if (info.type !== 'password' && info.type !== 'hidden' && info.visible) {
            await all[i].click(); await sleep(3000);
            await all[i].type(WE_USERNAME, { delay: randomDelay(100, 200) });
            await sleep(3000);
            console.log(`    used input[${i}]`);
            return;
          }
        }
        throw new Error('no visible non-password input');
      },
      // M7: keyboard Tab from body
      async () => {
        await page.focus('body');
        await sleep(3000);
        await page.keyboard.press('Tab');
        await sleep(1000);
        await page.keyboard.type(WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    Tab from body + type');
      },
      // M8: click first input regardless of type
      async () => {
        await page.click('input');
        await sleep(3000);
        await page.keyboard.type(WE_USERNAME, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    click first input + keyboard');
      }
    ], 'SERVICE NUMBER', 60000);

    console.log('  [OK] Service number entered\n');

    // Human-like pause after username
    const delay2 = randomDelay(5000, 8000);
    console.log('  [HUMAN] pause', delay2, 'ms');
    await sleep(delay2);

    // Wait for dropdown to appear after username triggers React re-render
    console.log('  Waiting for dropdown to appear...');
    await withTimeout(
      page.waitForFunction(() => !!document.querySelector('.ant-select, .ant-select-selector, [class*="select"]'), { timeout: 15000 }),
      16000, 'dropdown appearance'
    ).catch(() => console.log('  [WARN] Dropdown wait timed out, proceeding anyway'));
    await sleep(1000);

    // Log dropdown state
    const dropdownDiag = await withTimeout(page.evaluate(() => ({
      antSelect: !!document.querySelector('.ant-select'),
      antSelectSelector: !!document.querySelector('.ant-select-selector'),
      anySelect: !!document.querySelector('[class*="select"]'),
      selectText: document.querySelector('.ant-select-selector')?.innerText || null
    })), 5000, 'dropdown diag').catch(() => null);
    console.log('  Dropdown state:', JSON.stringify(dropdownDiag));

    // ======================================
    console.log('STEP 3: DROPDOWN');
    // ======================================
    await tryMethods([
      async () => {
        await page.waitForFunction(() => !!document.querySelector('.ant-select-selector, .ant-select'), { timeout: 10000 });
        await sleep(500);
        const dropdown = await page.$('.ant-select-selector, .ant-select');
        if (!dropdown) throw new Error('dropdown not found after wait');
        await dropdown.click();
        await sleep(1500);
        const clicked = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.ant-select-item-option, .ant-select-item, li'));
          const internet = items.find(i => i.textContent.toLowerCase().includes('internet'));
          if (internet) { internet.click(); return internet.textContent.trim(); }
          return null;
        });
        if (!clicked) throw new Error('Internet option not found');
        console.log('    waitForFunction + click, selected:', clicked);
        await sleep(500);
      },
      async () => {
        await page.waitForSelector('.ant-select-selector', { timeout: 10000 });
        await sleep(500);
        await page.click('.ant-select-selector');
        await sleep(1500);
        await page.evaluate(() => {
          for (let el of document.querySelectorAll('.ant-select-item-option, li, div')) {
            if (el.textContent?.toLowerCase().includes('internet')) { el.click(); return; }
          }
        });
        console.log('    waitForSelector + click');
        await sleep(500);
      },
      async () => {
        await page.waitForSelector('.ant-select', { timeout: 10000 });
        await page.click('.ant-select');
        await sleep(1500);
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        await page.keyboard.press('Enter');
        console.log('    click + arrow + enter');
      },
      async () => {
        await sleep(2000);
        await page.evaluate(() => { document.querySelector('.ant-select-selector')?.click(); });
        await sleep(2000);
        await page.evaluate(() => {
          for (let el of document.querySelectorAll('li, div, span')) {
            if (el.textContent?.toLowerCase().includes('internet')) { el.click(); return; }
          }
        });
        console.log('    evaluate click + broad search');
      },
      async () => {
        await sleep(2000);
        const els = await page.$$('[class*="select"]');
        if (els.length) { await els[0].click(); await sleep(2000); }
        await page.keyboard.type('Internet');
        await sleep(500);
        await page.keyboard.press('Enter');
        console.log('    generic selector + type');
      }
    ], 'DROPDOWN', 20000);

    console.log('  [OK] Dropdown done\n');

    // Human-like pause before password
    const delay3 = randomDelay(5000, 8000);
    console.log('  [HUMAN] pause', delay3, 'ms');
    await sleep(delay3);

    // ======================================
    console.log('STEP 4: PASSWORD');
    // ======================================
    await sleep(500);
    await tryMethods([
      async () => {
        await page.focus('#login_password_input_01');
        await sleep(3000);
        await page.type('#login_password_input_01', WE_PASSWORD, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    focus + type (local harvester method)');
      },
      async () => {
        const el = await page.$('#login_password_input_01');
        if (!el) throw new Error('ID not found');
        await el.click(); await sleep(3000);
        await el.type(WE_PASSWORD, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    $ find + click + type');
      },
      async () => {
        const els = await page.$$('input[type="password"]');
        if (!els.length) throw new Error('no password inputs');
        await els[0].click(); await sleep(3000);
        await els[0].type(WE_PASSWORD, { delay: randomDelay(100, 200) });
        await sleep(3000);
        console.log('    input[type=password]');
      },
      async () => {
        const ok = await page.evaluate((p) => {
          const inp = document.querySelector('#login_password_input_01') ||
                      document.querySelector('input[type="password"]');
          if (!inp) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(inp, p);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, WE_PASSWORD);
        if (!ok) throw new Error('DOM set failed');
        console.log('    DOM native setter');
      },
      async () => {
        const all = await page.$$('input');
        for (let i = 0; i < all.length; i++) {
          const type = await all[i].evaluate(el => el.type);
          if (type === 'password') {
            await all[i].click(); await sleep(3000);
            await all[i].type(WE_PASSWORD, { delay: randomDelay(100, 200) });
            await sleep(3000);
            console.log(`    loop found password at input[${i}]`);
            return;
          }
        }
        throw new Error('no password input in loop');
      }
    ], 'PASSWORD', 60000);

    console.log('  [OK] Password done\n');

    // Human-like pause before submit
    const delay4 = randomDelay(5000, 8000);
    console.log('  [HUMAN] pause', delay4, 'ms');
    await sleep(delay4);

    // ======================================
    console.log('STEP 5: SUBMIT');
    // ======================================
    
    // ULTIMATE SUBMISSION: Trigger all validation, wait for anti-bot, then click button
    await sleep(1000);
    const submitSuccess = await page.evaluate(() => {
      // Step 1: Trigger validation on all inputs
      const inputs = document.querySelectorAll('input');
      inputs.forEach(inp => {
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      
      // Step 2: Find the Login button (multiple strategies)
      const btns = Array.from(document.querySelectorAll('button'));
      let loginBtn = btns.find(b => 
        b.textContent && b.textContent.toLowerCase().includes('login') ||
        b.className && (b.className.includes('primary') || b.className.includes('submit'))
      );
      
      // Fallback: look for button inside form
      if (!loginBtn) {
        const form = document.querySelector('form');
        if (form) loginBtn = form.querySelector('button[type="submit"], button.ant-btn-primary');
      }
      
      // Fallback: last button on page (usually Submit/Login)
      if (!loginBtn && btns.length > 0) loginBtn = btns[btns.length - 1];
      
      if (!loginBtn) return { success: false, reason: 'No login button found' };
      
      // Step 3: Ensure button is enabled
      if (loginBtn.disabled) {
        loginBtn.disabled = false;
        loginBtn.classList.remove('ant-btn-disabled');
      }
      
      // Step 4: Click the button (multiple methods)
      try {
        loginBtn.click(); // Native click
        loginBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); // Synthetic click
        return { success: true, buttonText: loginBtn.textContent.trim() };
      } catch(e) {
        return { success: false, reason: e.message };
      }
    });
    
    console.log('    [SUBMIT] Result:', JSON.stringify(submitSuccess));
    
    if (!submitSuccess.success) {
      console.log('    [SUBMIT] Button click failed, trying Enter key fallback...');
      await page.keyboard.press('Enter');
    }
    
    await sleep(6000);

    // ======================================
    // POST-SUBMIT: Race - URL change vs captcha modal vs block
    // ======================================
    console.log('  Waiting for login result...');
    
    // IMMEDIATE CHECK: See if form validation error appeared
    // Skip generic UI text like "Internet", "Select Type", etc.
    await sleep(2000);
    const formError = await page.evaluate(() => {
      const errorEls = Array.from(document.querySelectorAll('.ant-form-item-explain-error, .ant-message-error, [class*="error"][class*="message"]'));
      for (const el of errorEls) {
        const txt = el.innerText?.trim();
        // Skip if it's just a single word (likely UI label, not error)
        if (txt && txt.length > 10 && txt.length < 200 && txt.split(' ').length > 1) {
          // Also skip if it contains common non-error words
          if (!/internet|select|type|dropdown|username|password/i.test(txt)) {
            return txt;
          }
        }
      }
      return null;
    });
    if (formError) {
      console.log('  [FORM ERROR] Validation failed:', formError);
      throw new Error('Form validation error: ' + formError);
    }

    // ======================================
    // ======================================
    // ULTIMATE NAVIGATION DETECTION v3
    // 100ms polling for INSTANT captcha detection (no more wasted attempts!)
    // Multi-signal: URL change OR dashboard elements OR block OR captcha
    // ======================================
    let postLoginState = 'unknown';
    const MAX_TICKS = 250; // 250 * 100ms = 25 seconds total
    
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const currentUrl = page.url();
      
      // Signal 1: URL changed away from login
      if (!currentUrl.includes('login')) {
        postLoginState = 'navigated';
        console.log('  [OK] URL changed to:', currentUrl, `(${tick * 0.1}s)`);
        break;
      }
      
      // Signal 2-5: Check page state (RAPID POLLING - check EVERY 100ms!)
      const pageState = await page.evaluate(() => {
        const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"], [class*="verification"]');
        const text = document.body.innerText.toLowerCase();
        const fullText = document.body.innerText;
        
        // CAPTCHA detection (multiple strategies for instant detection)
        const hasCaptcha = !!modal || 
                           text.includes('verification') || 
                           text.includes('enter code') ||
                           text.includes('captcha') ||
                           !!document.querySelector('input[placeholder*="code"]') ||
                           !!document.querySelector('input[placeholder*="Code"]') ||
                           !!document.querySelector('[class*="captcha"]');
        
        // Block message detection
        const isBlocked = text.includes('maximum') || text.includes('too many') ||
                          text.includes('exceeded') || text.includes('try again') ||
                          text.includes('blocked') || text.includes('محاولات') ||
                          text.includes('الحد الاقصى') || text.includes('مره اخرى');
        
        // Dashboard success indicators (even if URL didn't change - SPA navigation)
        const hasDashboard = fullText.includes('Current Balance') || 
                             fullText.includes('Remaining') ||
                             fullText.includes('Used') ||
                             !!document.querySelector('[class*="balance"]') ||
                             !!document.querySelector('[class*="dashboard"]') ||
                             !!document.querySelector('[class*="quota"]');
        
        // Still on login form?
        const stillOnLogin = fullText.includes('Service number') || 
                             fullText.includes('Select Type') ||
                             !!document.querySelector('#login_loginid_input_01');
        
        // VERBOSE DEBUG DATA
        const debugInfo = {
          modalCount: document.querySelectorAll('.ant-modal, [class*="modal"]').length,
          buttonCount: document.querySelectorAll('button:not([disabled])').length,
          inputCount: document.querySelectorAll('input[type="text"], input[type="password"]').length,
          bodyLength: fullText.length,
          firstLines: fullText.split('\n').slice(0, 8).join(' | ').slice(0, 300)
        };
        
        return { hasCaptcha, isBlocked, hasDashboard, stillOnLogin, text: text.slice(0, 200), debugInfo };
      });

      // VERBOSE LOGGING - Every 1 second (10 ticks × 100ms)
      if (tick % 10 === 0) {
        const elapsed = (tick * 0.1).toFixed(1);
        console.log(`  [DEBUG ${elapsed}s] cap:${pageState.hasCaptcha} dash:${pageState.hasDashboard} login:${pageState.stillOnLogin} block:${pageState.isBlocked} | modals:${pageState.debugInfo.modalCount} btns:${pageState.debugInfo.buttonCount}`);
        
        // Every 5 seconds, show page content
        if (tick > 0 && tick % 50 === 0) {
          console.log(`    → Page content: ${pageState.debugInfo.firstLines}`);
        }
      }

      // Priority 1: CAPTCHA detected (INSTANT - within first 100ms!)
      if (pageState.hasCaptcha) {
        postLoginState = 'captcha';
        const detectionTime = (tick * 0.1).toFixed(1);
        console.log(`  [CAPTCHA] ⚡ INSTANT DETECTION at ${detectionTime}s (tick ${tick})`);
        break;
      }

      // Priority 2: Dashboard detected (SUCCESS - even if URL didn't change)
      if (pageState.hasDashboard && !pageState.stillOnLogin) {
        postLoginState = 'navigated';
        console.log('  [OK] Dashboard detected (SPA navigation succeeded)');
        break;
      }

      // Priority 3: Block message detected
      if (pageState.isBlocked) {
        postLoginState = 'blocked';
        console.log('  [BLOCKED] WE has blocked this IP/account temporarily');
        console.log('  [BLOCKED] Page text:', pageState.text.slice(0, 150));
        break;
      }
      
      // Standard progress log (every 3 seconds)
      if (tick > 0 && tick % 30 === 0) {
        const seconds = Math.round(tick * 0.1);
        console.log(`  Waiting... ${seconds} s`);
      }
      
      // RAPID POLL: 100ms instead of 1000ms
      await sleep(100);
    }

    // Handle blocked state — don't throw immediately, note it but try extraction anyway
    // (Block message might be stale from previous run)
    if (postLoginState === 'blocked') {
      console.log('  ⚠️  Block message detected, but will attempt extraction anyway (might be stale)');
      // Don't throw here - let extraction step determine if it's a real block
    }

    if (postLoginState === 'unknown') {
      // FINAL DEBUG DUMP before giving up
      console.log('  [FINAL DEBUG] Capturing page state before error...');
      const finalDebug = await page.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          bodySnippet: document.body.innerText.slice(0, 500),
          visibleModals: Array.from(document.querySelectorAll('.ant-modal, [class*="modal"]')).map(m => ({
            visible: m.style.display !== 'none',
            className: m.className
          })),
          allButtons: Array.from(document.querySelectorAll('button')).slice(0, 10).map(b => ({
            text: b.textContent?.trim().slice(0, 30),
            disabled: b.disabled,
            visible: b.offsetParent !== null
          }))
        };
      });
      console.log('  [FINAL DEBUG]', JSON.stringify(finalDebug, null, 2));
      
      // Before giving up, do one final check for dashboard elements
      const finalCheck = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('Current Balance') || text.includes('Remaining');
      });
      if (finalCheck) {
        console.log('  [OK] Dashboard elements found on final check (slow SPA load)');
        postLoginState = 'navigated';
      } else {
        throw new Error('Still on login page - no navigation, dashboard, captcha, or block after 25s');

      }
    }

    // ======================================
    // CAPTCHA ENGINE v4 (only if captcha was detected)
    // ======================================
    if (postLoginState === 'captcha') {
      console.log('  [CAPTCHA] Ultimate Engine v5 starting...\n');

      // HELPER: Find the captcha image (largest img inside modal)
      // Accepts image even if naturalWidth===0 (lazy-load / slow server) as long as
      // the element has visible dimensions — prevents "No valid captcha image" loops.
      async function findCaptchaImg() {
        return await page.evaluateHandle(() => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          if (!modal) return null;
          const imgs = Array.from(modal.querySelectorAll('img'));
          imgs.sort((a, b) => {
            const aR = a.getBoundingClientRect(), bR = b.getBoundingClientRect();
            return (bR.width * bR.height) - (aR.width * aR.height);
          });
          // Pass 1: prefer fully loaded image (naturalWidth > 0)
          for (const img of imgs) {
            const r = img.getBoundingClientRect();
            if (r.width > 80 && r.height > 25 && img.naturalWidth > 0) return img;
          }
          // Pass 2: accept visible image even if naturalWidth not ready yet
          for (const img of imgs) {
            const r = img.getBoundingClientRect();
            if (r.width > 80 && r.height > 25) return img;
          }
          return null;
        });
      }

      // HELPER: Canvas preprocessing — 18 filter modes for WE captcha
      async function canvasProcess(imgHandle, filter) {
        return await page.evaluate((imgEl, f) => {
          if (!imgEl) return null;
          // Use naturalWidth if available; fall back to rendered dimensions for lazy-loaded imgs
          const w = imgEl.naturalWidth  || imgEl.getBoundingClientRect().width;
          const h = imgEl.naturalHeight || imgEl.getBoundingClientRect().height;
          if (!w || !h) return null;
          const scale = 3;
          const c = document.createElement('canvas');
          c.width  = w * scale;
          c.height = h * scale;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(imgEl, 0, 0, c.width, c.height);
          const data = ctx.getImageData(0, 0, c.width, c.height);
          const d = data.data;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i+1], b = d[i+2];
            const lum = 0.299*r + 0.587*g + 0.114*b;
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            const sat = max === 0 ? 0 : (max - min) / max;
            let keep = false;
            // ── GROUP A: Color-based (WE captcha uses colored text on white/gray bg) ──
            if      (f === 'colorOnly')   { keep = sat > 0.25 && lum < 220 && lum > 20; }
            else if (f === 'colorStrong') { keep = sat > 0.45 && lum < 200 && lum > 15; }
            else if (f === 'colorWide')   { keep = sat > 0.15 && lum < 230 && lum > 10; }
            else if (f === 'red')         { keep = r > 100 && (r-g) > 30 && (r-b) > 30; }
            else if (f === 'redLoose')    { keep = r > 80  && (r-g) > 20 && (r-b) > 20; }
            else if (f === 'blue')        { keep = b > 100 && (b-r) > 30 && (b-g) > 20; }
            else if (f === 'green')       { keep = g > 100 && (g-r) > 30 && (g-b) > 30; }
            else if (f === 'notGray')     { keep = (max - min) > 40 && lum < 210; }
            // ── GROUP B: Luminance-based ──
            else if (f === 'dark')        { keep = lum < 140; }
            else if (f === 'dark2')       { keep = lum < 100; }
            else if (f === 'dark3')       { keep = lum < 170; }
            else if (f === 'midtone')     { keep = lum >= 60 && lum <= 180; }
            // ── GROUP C: Contrast / threshold ──
            else if (f === 'contrast')    { keep = sat > 0.3 && r > g; }
            else if (f === 'thresh128')   { keep = lum < 128; }
            else if (f === 'thresh160')   { keep = lum < 160; }
            // ── GROUP D: Channel-boost hybrids ──
            else if (f === 'rBoost')      { const rb = Math.min(255, r*1.4); keep = rb > 140 && (rb-g) > 25; }
            else if (f === 'gBoost')      { const gb2 = Math.min(255, g*1.4); keep = gb2 > 120 && (gb2-r) > 20; }
            else if (f === 'satBoost')    { keep = sat > 0.35 && lum < 190 && lum > 25; }
            d[i] = d[i+1] = d[i+2] = keep ? 0 : 255;
          }
          ctx.putImageData(data, 0, 0);
          return c.toDataURL('image/png');
        }, imgHandle, filter);
      }

      // HELPER: OCR with dual PSM modes — returns only results >= 5 chars
      async function ocrRead(imageData) {
        const Tesseract = require('tesseract.js');
        const results = [];
        const r1 = await Tesseract.recognize(imageData, 'eng', {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
          tessedit_pageseg_mode: '8'
        });
        const t1 = r1.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
        if (t1 && t1.length >= 5) results.push(t1);
        else if (t1 && t1.length < 5) console.log('    [OCR] Rejected "' + t1 + '" (< 5 chars)');
        if (!results.length || t1.length !== 5) {
          const r2 = await Tesseract.recognize(imageData, 'eng', {
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            tessedit_pageseg_mode: '7'
          });
          const t2 = r2.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
          if (t2 && t2 !== t1 && t2.length >= 5) results.push(t2);
          else if (t2 && t2.length < 5) console.log('    [OCR] Rejected "' + t2 + '" (< 5 chars)');
        }
        return results;
      }

      // HELPER: Submit captcha answer into modal input
      async function submitAnswer(answer) {
        console.log('    -> Submitting:', answer);
        const ok = await page.evaluate((ans) => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          if (!modal) return false;
          const inp = modal.querySelector('input.ant-input, input[type="text"]');
          if (!inp) return false;
          inp.focus();
          inp.click();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, '');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          setter.call(inp, ans);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          // Find the OK/confirm button — NOT Cancel. Look for button with ok/confirm text,
          // or ant-btn-primary class, or the LAST button (Cancel is usually first, Ok is last)
          const allBtns = Array.from(modal.querySelectorAll('button'));
          const btn = allBtns.find(b => /ok|confirm|submit/i.test(b.textContent)) ||
                      modal.querySelector('button.ant-btn-primary') ||
                      allBtns[allBtns.length - 1]; // last button = OK
          console.log('[captcha] Clicking button:', btn ? btn.textContent.trim() : 'none', 'of', allBtns.length, 'buttons');
          if (btn) btn.click();
          return true;
        }, answer);
        if (!ok) {
          console.log('    -> Keyboard fallback');
          await page.keyboard.press('Tab');
          await sleep(200);
          await page.keyboard.type(answer, { delay: 40 });
          await sleep(300);
          await page.keyboard.press('Enter');
        }
        await sleep(5000);
        return !page.url().includes('login');
      }

      // HELPER: Check if modal is still open
      async function isModalOpen() {
        return await page.evaluate(() => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          return !!modal;
        });
      }

      // HELPER: Re-trigger captcha — full page reload + fresh login
      // (old button-click approach is unreliable after WE resets form state)
      async function doFullReLogin() {
        console.log('    [RETRIGGER] Full page reload + re-login...');
        try {
          await page.goto('https://my.te.eg/echannel/', { waitUntil: 'networkidle2', timeout: 30000 });
          await page.waitForFunction(
            () => document.querySelectorAll('input').length >= 2, { timeout: 15000 }
          );
          await sleep(randomDelay(2000, 3000));
          // Username
          await page.focus('#login_loginid_input_01').catch(() => {});
          await sleep(500);
          await page.type('#login_loginid_input_01', WE_USERNAME, { delay: randomDelay(80, 140) });
          await sleep(randomDelay(2000, 3500));
          // Dropdown
          await page.waitForFunction(
            () => !!document.querySelector('.ant-select-selector, .ant-select'), { timeout: 10000 }
          ).catch(() => {});
          const dd = await page.$('.ant-select-selector, .ant-select');
          if (dd) { await dd.click(); await sleep(1200); }
          await page.evaluate(() => {
            for (const el of document.querySelectorAll('.ant-select-item-option, li')) {
              if (el.textContent && el.textContent.toLowerCase().includes('internet')) { el.click(); return; }
            }
          });
          await sleep(randomDelay(2000, 3500));
          // Password
          await page.focus('#login_password_input_01').catch(() => {});
          await sleep(500);
          await page.type('#login_password_input_01', WE_PASSWORD, { delay: randomDelay(80, 140) });
          await sleep(randomDelay(2000, 3000));
          // Submit
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.textContent.toLowerCase().includes('login') || b.className.includes('primary'));
            if (btn) btn.click();
          });
          // Wait 5s for submit to process, then check for modal (up to 25s total)
          await sleep(5000);
          for (let w = 0; w < 25; w++) {
            await sleep(1000);
            if (!page.url().includes('login')) return 'navigated';
            const hasModal = await page.evaluate(() => !!document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]'));
            if (hasModal) return 'modal';
          }
          return 'timeout';
        } catch(e) {
          console.log('    [RETRIGGER] Error:', e.message);
          return 'error';
        }
      }

      // ======================================================================
      // MAIN CAPTCHA LOOP -- Ultimate Engine v5
      //
      // VOTING RULES:
      //   colorOnly = 3 votes  (always runs, always in pool)
      //   every other filter  = 1 vote each
      //   OCR noise normalization before grouping (0/O, 1/I/l, 5/S, 6/G, 8/B, 9/G, Q/G)
      //   top-2 candidates submitted IN THE SAME ROUND
      //   case cycling: round%3 -> orig / UPPER / lower
      //   image: accept visible img even if naturalWidth===0 (lazy-load fallback)
      //   modal retrigger: full page reload + full re-login (guaranteed fresh captcha)
      // ======================================================================

      const ALL_FILTERS = [
        'colorOnly',
        'colorStrong','colorWide','red','redLoose',
        'blue','green','notGray',
        'dark','dark2','dark3','midtone',
        'contrast','thresh128','thresh160',
        'rBoost','gBoost','satBoost'
      ];

      // Normalize OCR result for vote grouping — collapses common OCR confusion chars
      function normalizeOCR(str) {
        return str.toUpperCase()
          .replace(/0/g, 'O')
          .replace(/1/g, 'I')
          .replace(/L/g, 'I')
          .replace(/5/g, 'S')
          .replace(/6/g, 'G')
          .replace(/8/g, 'B')
          .replace(/9/g, 'G')
          .replace(/Q/g, 'G');
      }

      let captchaSolved = false;

      for (let round = 1; round <= 12 && !captchaSolved; round++) {
        console.log('  -- Round', round, '/ 12 --');

        // -- Round > 1: wait for modal, retrigger if missing -------------------
        if (round > 1) {
          let modalReady = false;
          for (let w = 0; w < 15; w++) {
            await sleep(1000);
            if (!page.url().includes('login')) { captchaSolved = true; console.log('  [OK] Navigated away!'); break; }
            if (await isModalOpen()) { modalReady = true; break; }
          }
          if (captchaSolved) break;

          if (!modalReady) {
            const result = await doFullReLogin();
            console.log('    [RETRIGGER] Result:', result);
            if (result === 'navigated') { captchaSolved = true; break; }
            if (result === 'modal')     { modalReady = true; }
            if (!modalReady) { console.log('    ! No modal after full re-login, skipping round'); continue; }
          }
          await sleep(1500);
        }

        try {
          // -- REFRESH LOOP: Try up to 3 refreshes if OCR confidence < 80% ------
          let ocrAttempt = 0;
          let votes = null;
          let imgHandle = null;

          while (ocrAttempt < 3) {
            ocrAttempt++;
            if (ocrAttempt > 1) {
              console.log('    [REFRESH] OCR confidence too low, clicking refresh button...');
              const refreshed = await page.evaluate(() => {
                const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
                if (!modal) return false;
                // Find refresh/reload button near captcha (usually has reload icon or "Refresh" text)
                const btns = Array.from(modal.querySelectorAll('button, .anticon-reload, [class*="reload"], [class*="refresh"]'));
                const refreshBtn = btns.find(b => 
                  b.className && (b.className.includes('reload') || b.className.includes('refresh')) ||
                  b.textContent && /refresh|reload/i.test(b.textContent) ||
                  b.querySelector('.anticon-reload')
                );
                if (refreshBtn) {
                  refreshBtn.click();
                  return true;
                }
                // Fallback: click img itself (some captchas refresh on img click)
                const img = modal.querySelector('img');
                if (img) { img.click(); return true; }
                return false;
              });
              if (!refreshed) { console.log('    ! Refresh button not found, proceeding with current image'); break; }
              await sleep(3000); // wait for new image to load
            }

            // -- Wait for valid captcha image (up to 30s) -----------------------
            imgHandle = null;
            for (let retry = 0; retry < 30; retry++) {
              imgHandle = await findCaptchaImg();
              const isValid = await page.evaluate(function(el) {
                if (!el) return false;
                if (el.naturalWidth > 0) return true;
                var r = el.getBoundingClientRect();
                return r.width > 80 && r.height > 25;
              }, imgHandle).catch(() => false);
              if (isValid) break;
              imgHandle = null;
              await sleep(1000);
            }
            if (!imgHandle) { console.log('    ! No valid captcha image after 30s'); break; }

            // -- Run ALL 18 filters + build weighted vote pool ------------------
            // colorOnly = 3 votes, all others = 1 vote
            // Normalize before grouping to collapse OCR noise variants
            votes = {};
            let filtersVoted = 0;

            for (const filter of ALL_FILTERS) {
              const b64 = await canvasProcess(imgHandle, filter);
              if (!b64) continue;
              const texts = await ocrRead(b64);
              // Prefer exact 5-char; also accept 6+ truncated to 5 as fallback
              const raw = texts.find(function(t) { return t.length === 5; }) ||
                          (texts.find(function(t) { return t.length > 5; }) || '').slice(0, 5) || null;
              console.log('    [' + filter + '] OCR:', JSON.stringify(texts), raw ? '[OK]' : '[SKIP]');
              if (!raw || raw.length < 5) continue;
              filtersVoted++;
              const normed = normalizeOCR(raw);
              const weight = filter === 'colorOnly' ? 3 : 1;
              if (!votes[normed]) votes[normed] = { weight: 0, best: raw };
              votes[normed].weight += weight;
              // colorOnly's reading takes precedence as the "best" original for submission
              if (filter === 'colorOnly') votes[normed].best = raw;
            }

            if (!Object.keys(votes).length) { console.log('    ! No 5-char result from any filter'); continue; }

            const ranked = Object.entries(votes).sort(function(a, b) { return b[1].weight - a[1].weight; });
            const maxWeight = ranked[0][1].weight;
            const totalPossible = filtersVoted; // rough estimate (colorOnly=3, others=1)
            const confidence = (maxWeight / totalPossible) * 100;
            console.log('    [VOTE] Results:', ranked.map(function(e) { return e[0]+'(w='+e[1].weight+')'; }).join(', '));
            console.log('    [CONFIDENCE] ' + confidence.toFixed(0) + '% (top=' + maxWeight + ' / voted=' + filtersVoted + ')');

            if (confidence >= 80 || ocrAttempt >= 3) {
              console.log('    [OCR] Confidence acceptable or max refreshes reached — proceeding to submit');
              break;
            } else {
              console.log('    [OCR] Confidence < 80%, will refresh captcha image');
              votes = null; // reset for next attempt
            }
          }

          if (!votes || !Object.keys(votes).length) { 
            console.log('    ! No acceptable OCR result after 3 refresh attempts'); 
            continue; 
          }

          const ranked = Object.entries(votes).sort(function(a, b) { return b[1].weight - a[1].weight; });

          // -- Submit top-5 candidates with 7 case variants each ----------------
          const top5 = ranked.slice(0, 5);
          const triedVariants = {}; // dedup tracker

          for (const entry of top5) {
            if (captchaSolved) break;
            const orig = entry[1].best;
            
            // Generate 7 case variants
            const variants = [
              orig,                                                    // orig
              orig.toUpperCase(),                                      // UPPER
              orig.toLowerCase(),                                      // lower
              orig.charAt(0).toUpperCase() + orig.slice(1).toLowerCase(), // Capitalized
              orig.charAt(0).toLowerCase() + orig.slice(1).toUpperCase(), // iNVERTED
              orig.split('').map(function(c, i) { return i % 2 === 0 ? c.toLowerCase() : c.toUpperCase(); }).join(''), // aLtErNaTe
              orig.split('').map(function(c, i) { return i % 2 === 0 ? c.toUpperCase() : c.toLowerCase(); }).join('')  // AlTeRnAtE
            ];

            for (let v = 0; v < variants.length; v++) {
              if (captchaSolved) break;
              const attempt = variants[v];
              if (triedVariants[attempt]) continue; // skip duplicate
              triedVariants[attempt] = true;

              const variantNames = ['orig', 'UPPER', 'lower', 'Capital', 'iNVERT', 'aLtErN', 'AlTeRn'];
              console.log('    -> Trying [' + variantNames[v] + '] w=' + entry[1].weight + ':', attempt);
              captchaSolved = await submitAnswer(attempt);
              if (captchaSolved) { console.log('  >>> CAPTCHA SOLVED round', round, '! <<<'); break; }
              console.log('    X Wrong "' + attempt + '"');
              const stillOpen = await isModalOpen();
              if (!stillOpen) { if (!page.url().includes('login')) captchaSolved = true; break; }
              await sleep(1500);
            }
          }
        } catch (e) {
          console.log('    ! Error:', e.message);
        }
      }

      if (!captchaSolved) {
        await page.evaluate(() => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          const btn = modal && modal.querySelector('button');
          if (btn) btn.click();
        });
        await sleep(2000);
        throw new Error('Captcha unsolvable after 12 rounds - retrying login');
      }
      
      // ══════════════════════════════════════
      // POST-CAPTCHA NAVIGATION VERIFICATION
      // CRITICAL: Wait for dashboard to load before proceeding!
      // ══════════════════════════════════════
      console.log('  [POST-CAPTCHA] Waiting for dashboard navigation...');
      
      let dashboardReached = false;
      let interstitialPageDetected = false;
      
      for (let tick = 0; tick < 300; tick++) { // 30 seconds max (300 × 100ms)
        const currentUrl = page.url();
        
        // Check page state
        const pageCheck = await page.evaluate(() => {
          const text = document.body.innerText;
          const url = window.location.href;
          const hasLoginForm = !!document.querySelector('#login_loginid_input_01');
          const hasDashboard = text.includes('Current Balance') || 
                               text.includes('Remaining') ||
                               text.includes('Used') ||
                               !!document.querySelector('[class*="balance"]');
          
          // Detect interstitial/promo pages (anonymoustopup, promotions, ads, etc.)
          const isInterstitial = url.includes('anonymoustopup') || 
                                 url.includes('promotion') ||
                                 url.includes('offer') ||
                                 url.includes('topup') ||
                                 (url.includes('echannel') && !url.includes('login') && !hasDashboard);
          
          return { hasLoginForm, hasDashboard, isInterstitial, url };
        });
        
        // Interstitial page detected (e.g. /anonymoustopup) - navigate to dashboard
        if (pageCheck.isInterstitial && !interstitialPageDetected) {
          interstitialPageDetected = true;
          const waitTime = (tick * 0.1).toFixed(1);
          console.log(`  ⚠️  Interstitial page detected after ${waitTime}s: ${pageCheck.url}`);
          console.log('  → Navigating to dashboard...');
          
          // Try multiple navigation strategies
          await page.evaluate(() => {
            // Strategy 1: Click any "Skip" / "Close" / "Continue" buttons
            const btns = Array.from(document.querySelectorAll('button, a'));
            const skipBtn = btns.find(b => {
              const txt = b.textContent?.toLowerCase() || '';
              return txt.includes('skip') || txt.includes('close') || txt.includes('continue') || 
                     txt.includes('later') || txt.includes('cancel') || txt.includes('×');
            });
            if (skipBtn) {
              skipBtn.click();
              return;
            }
            
            // Strategy 2: Navigate to home/dashboard via URL
            if (window.location.hash) {
              window.location.hash = '#/home';
            }
          }).catch(() => {});
          
          await sleep(2000);
          continue; // Re-check page state
        }
        
        // Success: Dashboard loaded
        if (pageCheck.hasDashboard && !pageCheck.hasLoginForm) {
          dashboardReached = true;
          const waitTime = (tick * 0.1).toFixed(1);
          console.log(`  ✓ Dashboard reached after ${waitTime}s`);
          break;
        }
        
        // Failure: Redirected back to login
        if (pageCheck.hasLoginForm && !pageCheck.hasDashboard) {
          const waitTime = (tick * 0.1).toFixed(1);
          console.log(`  ✗ Redirected to login after ${waitTime}s - CAPTCHA solve didn't authenticate`);
          throw new Error('Post-CAPTCHA redirect to login - authentication failed');
        }
        
        // Log progress
        if (tick > 0 && tick % 30 === 0) {
          console.log(`    Waiting for dashboard... ${Math.round(tick * 0.1)}s`);
        }
        
        await sleep(100);
      }
      
      if (!dashboardReached) {
        const finalUrl = page.url();
        throw new Error(`Dashboard did not load within 30s after CAPTCHA solve. Final URL: ${finalUrl}`);
      }
    }


    // ══════════════════════════════════════
    console.log('STEP 2: SERVICE NUMBER (USERNAME)');
    // ══════════════════════════════════════
    console.log('  ✓ Login successful!\n');

    // NOTE: Cookie save moved to AFTER line switch + dashboard verification (below)
    // to prevent saving invalid cookies when CAPTCHA solve doesn't actually authenticate

    } // end if (!sessionValid)

    // ── dismissAds: close any overlay/ad/popup before line switch ──────────
    async function dismissAds() {
      try {
        const dismissed = await page.evaluate(() => {
          let count = 0;
          // Close buttons on overlays, modals, banners, promo popups
          const selectors = [
            '[class*="close"]', '[class*="dismiss"]', '[class*="modal"] button',
            '[aria-label="Close"]', '[aria-label="close"]',
            'button[class*="cancel"]', 'button[class*="Cancel"]',
            '.ant-modal-close', '.ant-modal-close-x'
          ];
          for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
              const r = el.getBoundingClientRect();
              const visible = r.width > 0 && r.height > 0;
              const isMainModal = el.closest('.ant-modal-content')?.querySelector('input');
              if (visible && !isMainModal) {
                el.click();
                count++;
              }
            }
          }
          return count;
        });
        if (dismissed > 0) {
          console.log('  [dismissAds] Closed', dismissed, 'overlay(s)');
          await sleep(1500);
        } else {
          console.log('  [dismissAds] No ads/overlays found');
        }
      } catch(e) { console.log('  [dismissAds] Non-fatal:', e.message); }
    }
    await dismissAds();
    // ────────────────────────────────────────────────────────────────────────

    // ══════════════════════════════════════
    console.log('STEP 5.5: LINE SWITCHER (Dokki)');
    // ══════════════════════════════════════
    console.log('  Switching to line 0237600094...');

    // FORCE NAVIGATION: WE sometimes redirects to wrong page after login.
    // Explicitly navigate to accountoverview BEFORE attempting line switch.
    const currentUrl = page.url();
    if (!currentUrl.includes('accountoverview')) {
      console.log('  [NAVIGATE] Current URL:', currentUrl);
      console.log('  [NAVIGATE] Forcing navigation to accountoverview...');
      await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      const newUrl = page.url();
      console.log('  [NAVIGATE] New URL:', newUrl);
      if (newUrl.includes('login')) {
        throw new Error('WE forced redirect to login after navigation — possible session block');
      }
    }

    // CRITICAL: The WE portal does a session refresh after line switch that can
    // redirect back to #/login within seconds. The only reliable approach is to
    // extract the data THE MOMENT we confirm the correct page is showing —
    // before the redirect can happen. We capture data inside the switcher itself.

    // Helper: extract all quota data from the current page state
    async function extractNow() {
      const result = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span, div, p'));
        let remaining = null, used = null, balance = null, plan = null;
        function isNumericText(t) {
          if (!t) return false;
          const s = t.replace(/,/g, '').trim();
          return /^\d+(\.\d+)?$/.test(s) && !s.startsWith('0237') && !s.startsWith('023');
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
          if (t.includes('GB') && t.toLowerCase().includes('speed')) plan = t;
        }
        if (!remaining) {
          // Fallback: regex on full page text
          const text = document.body.innerText;
          const r = text.match(/([\d,]+\.?\d+)\s*\n?\s*Remaining/i);
          const u = text.match(/([\d,]+\.?\d+)\s*\n?\s*Used/i);
          const b = text.match(/Current Balance\s*\n?\s*([\d,]+\.?\d+)/i) || text.match(/([\d,]+\.?\d+)\s*EGP/i);
          const p = text.match(/[^\n]*\d+\s*GB[^\n]*[Ss]peed[^\n]*/);
          if (!r) return null;
          return { remaining: r[1], used: u?.[1]||'0', balance: b?.[1]||'0', plan: p?.[0]?.trim()||'Unknown' };
        }
        return { remaining, used: used||'0', balance: balance||'0', plan: plan||'Unknown' };
      });
      if (!result) return null;
      const parsed = {
        remaining: stripNum(result.remaining),
        used: stripNum(result.used) || 0,
        balance: stripNum(result.balance) || 0,
        plan: result.plan
      };
      return (parsed.remaining || parsed.remaining === 0) ? parsed : null;
    }

    // Helper: check page is showing correct line with actual data
    // IMPORTANT: checks the ACTIVE line widget (top-left "You are currently managing")
    // NOT just text.includes() which can false-positive from hidden dropdown options
    async function checkPage094() {
      return await page.evaluate(() => {
        // Method 1: Check the active line widget specifically
        // The "You are currently managing" shows the ACTIVE line number
        const activeEl = document.querySelector(
          '#accountOverview_currentNumber, .ant-select-selection-item, [class*="currentNumber"], [class*="current-number"]'
        );
        const activeText = activeEl ? activeEl.innerText?.trim() : '';

        // Method 2: Check the small line number display near "You are currently managing"
        const managingEls = Array.from(document.querySelectorAll('span, div'));
        let managingLine = '';
        for (let i = 0; i < managingEls.length; i++) {
          const t = managingEls[i].innerText?.trim();
          if (t && t.includes('currently managing')) {
            // The line number is usually in a nearby sibling or child
            const nearby = managingEls[i+1]?.innerText?.trim() || managingEls[i+2]?.innerText?.trim() || '';
            if (nearby.includes('023760009')) { managingLine = nearby; break; }
            // Also check children
            const child = managingEls[i].querySelector('[class*="number"], [class*="select"]');
            if (child) { managingLine = child.innerText?.trim(); break; }
          }
        }

        // Method 3: Look for 0237600094 specifically in small/label elements (not huge containers)
        let foundIn094Widget = false;
        for (const el of document.querySelectorAll('span, a, button, label, .ant-select-selection-item')) {
          const t = el.innerText?.trim();
          if (t && t.includes('0237600094') && t.length < 20) {
            foundIn094Widget = true;
            break;
          }
        }

        const rem = document.body.innerText.match(/([\d,]+\.?\d+)\s*\n?\s*Remaining/i)?.[1] || '';
        const bal = document.body.innerText.match(/Current Balance\s*\n?\s*([\d,]+\.?\d+)/i)?.[1]
                 || document.body.innerText.match(/([\d,]+\.?\d+)\s*EGP/i)?.[1] || '0';
        const balNum = parseFloat(bal.replace(/,/g, '')) || 0;

        // Line 0237600094 has balance > 3000 EGP (line 0237600093 has ~1923 EGP)
        const isCorrectByBalance = balNum > 3000;

        const has094 = activeText.includes('0237600094') || managingLine.includes('0237600094') || foundIn094Widget || isCorrectByBalance;

        return {
          has094,
          activeText,
          managingLine,
          foundIn094Widget,
          isCorrectByBalance,
          balNum,
          rem,
          hasRemaining: !!rem
        };
      }).catch(() => ({ has094: false, activeText: '', managingLine: '', foundIn094Widget: false, isCorrectByBalance: false, balNum: 0, rem: '', hasRemaining: false }));
    }

    // The captured data from inside the switcher (avoids race condition)
    let switcherCapturedData = null;

    await tryMethods([
      // M1: Click dropdown → select 0237600094 → capture data immediately on confirmation
      async () => {
        await page.waitForFunction(() => {
          const t = document.body.innerText;
          return t.includes('currently managing') || t.includes('Remaining');
        }, { timeout: 15000 });
        await sleep(1500);
        console.log('    Pre-switch URL:', page.url());

        // Open the line switcher dropdown
        const dropdowns = await page.$$('.ant-select-selector, .ant-select');
        if (!dropdowns.length) throw new Error('Dropdown not found');
        await dropdowns[0].click();
        await sleep(800);
        // DISMISS ANY POPUPS AFTER DROPDOWN CLICK
        console.log('    [POST-DROPDOWN] Dismissing popups...');
        await dismissAds();
        await sleep(700);

        // Click 0237600094
        const clicked = await page.evaluate(() => {
          const opts = Array.from(document.querySelectorAll(
            '.ant-select-item-option-content, .ant-select-item, li, option'
          ));
          const t = opts.find(o => o.textContent && o.textContent.includes('0237600094'));
          if (t) { t.click(); return t.textContent.trim(); }
          return null;
        });
        if (!clicked) throw new Error('Option 0237600094 not found');
        console.log('    Clicked:', clicked);

        // Poll aggressively — capture data THE MOMENT the page shows 0237600094 AND full data loaded
        for (let w = 0; w < 30; w++) {
          await sleep(1000);
          const url = page.url();
          const check = await checkPage094();

          // If stuck on login after 5s, fail this method
          if (url.includes('#/login') && w > 5) throw new Error('Redirected to login after line switch');

          // CRITICAL: Must satisfy ALL conditions for valid capture:
          // 1. check.hasRemaining = true (data visible)
          // 2. check.has094 = true (correct line showing)
          // 3. balance > 3000 (line 94 has ~9856 EGP, line 93 has ~1923 EGP)
          // 4. balance > 0 (data fully loaded, not still loading)
          // 5. plan !== 'Unknown' (full page rendered)
          // 6. remaining + used > 300 GB (line 94 = 750GB plan, line 93 = 250GB plan)
          //    This catches mixed-state where balance updated but remaining/used still from line 93
          if (check.hasRemaining && check.has094) {
            const captured = await extractNow();
            if (captured) {
              const totalGB = (captured.remaining || 0) + (captured.used || 0);
              if (captured.balance > 3000 && captured.balance > 0 && captured.plan !== 'Unknown' && totalGB > 300) {
                switcherCapturedData = captured;
                console.log('    ✓ M1 FULL DATA CAPTURED: remaining=' + captured.remaining + ' used=' + captured.used + ' total=' + totalGB.toFixed(1) + 'GB balance=' + captured.balance + ' plan=' + captured.plan);
                return; // SUCCESS
              } else if (captured.balance > 0 && captured.balance < 3000) {
                console.log('    ⚠ (' + (w+1) + 's) Balance ' + captured.balance + ' < 3000 — WRONG LINE (093), waiting for 094...');
              } else if (captured.balance === 0) {
                console.log('    ⏳ (' + (w+1) + 's) Balance=0, page still loading... rem=' + captured.remaining);
              } else if (captured.plan === 'Unknown') {
                console.log('    ⏳ (' + (w+1) + 's) Plan=Unknown, page still rendering... rem=' + captured.remaining + ' bal=' + captured.balance);
              } else if (totalGB <= 300) {
                console.log('    ⚠ (' + (w+1) + 's) MIXED STATE: balance=' + captured.balance + ' (094✓) but rem+used=' + totalGB.toFixed(1) + 'GB (093 plan=250GB!) — waiting for full 094 data...');
              } else {
                console.log('    ⏳ (' + (w+1) + 's) Data incomplete, waiting... rem=' + captured.remaining + ' bal=' + captured.balance + ' total=' + totalGB.toFixed(1));
              }
            } else {
              console.log('    ⏳ (' + (w+1) + 's) extractNow returned null, waiting...');
            }
          } else {
            console.log('    ⏳ (' + (w+1) + 's) URL:' + url.split('#')[1] + ' | has094:' + check.has094 + ' | hasRem:' + check.hasRemaining + ' | bal:' + check.balNum);
          }
        }
        throw new Error('M1: Page did not show line 94 FULL data (balance>3000, totalGB>300, plan loaded) in 30s');
      },

      // M2: Broad evaluate click → same capture strategy
      async () => {
        await sleep(2000);
        // Try all possible selectors for the dropdown
        await page.evaluate(() => {
          // Try ant-select first
          const sel = document.querySelector('.ant-select-selector, .ant-select');
          if (sel) sel.click();
        });
        await sleep(1500);
        // Click target line
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('div, li, option, span, a, .ant-select-item')) {
            if (el.textContent && el.textContent.trim().includes('0237600094')) { el.click(); return; }
          }
        });
        console.log('    Broad click done, waiting for page...');

        // Same aggressive capture strategy with ALL verification criteria
        for (let w = 0; w < 25; w++) {
          await sleep(1000);
          const url = page.url();
          const check = await checkPage094();

          if (url.includes('#/login') && w > 5) throw new Error('Redirected to login');

          // ALL 6 conditions must be true for valid capture
          if (check.hasRemaining && check.has094) {
            const captured = await extractNow();
            if (captured) {
              const totalGB = (captured.remaining || 0) + (captured.used || 0);
              if (captured.balance > 3000 && captured.balance > 0 && captured.plan !== 'Unknown' && totalGB > 300) {
                switcherCapturedData = captured;
                console.log('    ✓ M2 FULL DATA CAPTURED: remaining=' + captured.remaining + ' total=' + totalGB.toFixed(1) + 'GB balance=' + captured.balance);
                return;
              } else if (captured.balance > 0 && captured.balance < 3000) {
                console.log('    ⚠ (' + (w+1) + 's) Balance ' + captured.balance + ' < 3000 — WRONG LINE (093)');
              } else if (captured.balance === 0) {
                console.log('    ⏳ (' + (w+1) + 's) Balance=0, loading... rem=' + captured.remaining);
              } else if (captured.plan === 'Unknown') {
                console.log('    ⏳ (' + (w+1) + 's) Plan=Unknown, rendering... rem=' + captured.remaining + ' bal=' + captured.balance);
              } else if (totalGB <= 300) {
                console.log('    ⚠ (' + (w+1) + 's) MIXED STATE: balance=' + captured.balance + '✓ but total=' + totalGB.toFixed(1) + 'GB = 093 plan, waiting...');
              }
            }
          } else {
            console.log('    ⏳ (' + (w+1) + 's) rem:' + check.rem + ' | has094:' + check.has094 + ' | bal:' + check.balNum);
          }
        }
        throw new Error('M2: Page did not show line 94 FULL data (balance>3000, totalGB>300, plan loaded) in 25s');
      },

      // M3: page.select() + capture
      async () => {
        await sleep(2000);
        await page.select('select', '0237600094').catch(() => {});
        for (let w = 0; w < 25; w++) {
          await sleep(1000);
          const url = page.url();
          const check = await checkPage094();

          if (url.includes('#/login') && w > 5) throw new Error('Redirected to login');

          // ALL 6 conditions must be true for valid capture
          if (check.hasRemaining && check.has094) {
            const captured = await extractNow();
            if (captured) {
              const totalGB = (captured.remaining || 0) + (captured.used || 0);
              if (captured.balance > 3000 && captured.balance > 0 && captured.plan !== 'Unknown' && totalGB > 300) {
                switcherCapturedData = captured;
                console.log('    ✓ M3 FULL DATA CAPTURED: remaining=' + captured.remaining + ' total=' + totalGB.toFixed(1) + 'GB balance=' + captured.balance);
                return;
              } else if (captured.balance > 0 && captured.balance < 3000) {
                console.log('    ⚠ (' + (w+1) + 's) Balance ' + captured.balance + ' < 3000 — WRONG LINE (093)');
              } else if (captured.balance === 0) {
                console.log('    ⏳ (' + (w+1) + 's) Balance=0, loading... rem=' + captured.remaining);
              } else if (captured.plan === 'Unknown') {
                console.log('    ⏳ (' + (w+1) + 's) Plan=Unknown, rendering... rem=' + captured.remaining + ' bal=' + captured.balance);
              } else if (totalGB <= 300) {
                console.log('    ⚠ (' + (w+1) + 's) MIXED STATE: balance=' + captured.balance + '✓ but total=' + totalGB.toFixed(1) + 'GB = 093 plan, waiting...');
              }
            }
          } else {
            console.log('    ⏳ (' + (w+1) + 's) rem:' + check.rem + ' | has094:' + check.has094 + ' | bal:' + check.balNum);
          }
        }
        throw new Error('M3: Page did not show line 94 FULL data (balance>3000, totalGB>300, plan loaded) in 25s');
      }
    ], 'LINE SWITCHER', 45000);

    console.log('  ✓ Switched to 0237600094 | captured data:', switcherCapturedData ? 'YES' : 'NO');
    console.log('  Current URL:', page.url(), '\n');

    // ══════════════════════════════════════
    console.log('STEP 6: PERSISTENT EXTRACTION (7 cycles with refresh)');
    // ══════════════════════════════════════

    // ══════════════════════════════════════
    // SAVE SESSION COOKIES (MOVED HERE - after line switch + dashboard verification)
    // Only save cookies if we successfully reached dashboard with correct line
    // ══════════════════════════════════════
    try {
      const cookies = await page.cookies();
      const relevantCookies = cookies.filter(c => c.domain.includes('te.eg') || c.domain.includes('telecomegypt'));
      if (relevantCookies.length > 0) {
        await saveCookies(relevantCookies);
        console.log('  [SESSION] ✓ Valid session cookies saved (dashboard + line 094 verified)\n');
      }
    } catch(e) { console.log('  [SESSION] Could not save cookies:', e.message); }

    // Use pre-captured data from switcher if available (avoids race condition with redirect)
    // Only fall through to live extraction if switcher didn't capture data
    let data = null;
    
    if (switcherCapturedData) {
      console.log('  [FAST PATH] Using data captured during line switch (race-condition safe)');
      console.log('    Pre-captured during line switch');
      data = switcherCapturedData;
    } else {
      // Switcher didn't capture data — do persistent extraction with 7 cycles
      const MAX_EXTRACTION_CYCLES = 7;
      
      for (let cycle = 1; cycle <= MAX_EXTRACTION_CYCLES; cycle++) {
        try {
          console.log(`\n  --- EXTRACTION CYCLE ${cycle}/${MAX_EXTRACTION_CYCLES} ---`);
          
          // ══════════════════════════════════════
          // PRE-EXTRACTION PAGE VERIFICATION
          // Ensure we're on dashboard before attempting to extract
          // ══════════════════════════════════════
          const currentUrl = page.url();
          const pageVerification = await page.evaluate(() => {
            const text = document.body.innerText;
            const hasLoginForm = !!document.querySelector('#login_loginid_input_01') || 
                                 text.includes('Service number') ||
                                 text.includes('Select Type');
            const hasDashboard = text.includes('Current Balance') || 
                                 text.includes('Remaining') ||
                                 !!document.querySelector('[class*="balance"]');
            return { hasLoginForm, hasDashboard, url: window.location.href };
          });
          
          if (pageVerification.hasLoginForm && !pageVerification.hasDashboard) {
            console.log(`  ✗ ERROR: Still on login page (${pageVerification.url})`);
            console.log('  Session expired or redirect occurred - cannot extract from login form');
            throw new Error('SESSION_EXPIRED: Redirected to login page during extraction');
          }
          
          if (!pageVerification.hasDashboard) {
            console.log(`  ⚠️  WARNING: Dashboard elements not detected on page`);
            console.log(`  URL: ${pageVerification.url}`);
            console.log('  Attempting extraction anyway (might be slow-loading dashboard)...');
          } else {
            console.log(`  ✓ Page verification: On dashboard`);
          }
          
          // CRITICAL: Before each extraction cycle, re-switch to line 094
          // (Page might have reverted to 093 during refresh)
          if (cycle > 1) {
            console.log('  Re-switching to line 0237600094 before extraction...');
            await tryMethods([
              async () => {
                const selector = await page.$('select');
                if (selector) {
                  await page.select('select', '0237600094');
                  await sleep(3000); // Wait for line switch
                  console.log('    ✓ Line re-switched via select');
                }
              }
            ], 'RE-SWITCH', 10000).catch(e => console.log('    [WARN] Re-switch failed:', e.message));
          }
          
          data = await tryMethods([
            // M1: Walk ALL spans/divs — numeric sibling scan
            async () => {
              await sleep(2000);
              const result = await page.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('span, div, p'));
                let remaining = null, used = null, balance = null, plan = null;
                function isNumericText(t) {
                  if (!t) return false;
                  const s = t.replace(/,/g, '').trim();
                  return /^\d+(\.\d+)?$/.test(s) && !s.startsWith('0237') && !s.startsWith('023');
                }
                for (let i = 0; i < spans.length; i++) {
                  const t = spans[i].innerText?.trim();
                  if (!t || t.length > 100) continue;
                  if (t === 'Remaining') { for (let b=1;b<=3;b++) { const c=spans[i-b]?.innerText?.trim(); if(isNumericText(c)){remaining=c;break;} } }
                  if (t === 'Used')      { for (let b=1;b<=3;b++) { const c=spans[i-b]?.innerText?.trim(); if(isNumericText(c)){used=c;break;} } }
                  if (t === 'Current Balance') { for (let f=1;f<=5;f++) { const c=spans[i+f]?.innerText?.trim(); if(isNumericText(c)){balance=c;break;} } }
                  if (t.includes('GB') && t.toLowerCase().includes('speed')) plan = t;
                }
                if (!remaining) throw new Error('no remaining found');
                return { remaining, used: used||'0', balance: balance||'0', plan: plan||'Unknown' };
              });
              const parsed = { remaining: stripNum(result.remaining), used: stripNum(result.used)||0, balance: stripNum(result.balance)||0, plan: result.plan };
              if (!parsed.remaining && parsed.remaining !== 0) throw new Error('no data after stripNum');
              console.log('    M1 numeric-only sibling scan');
              return parsed;
            },
            // M2: Full page text regex
            async () => {
              await sleep(5000);
              const result = await page.evaluate(() => {
                const text = document.body.innerText;
                const r = text.match(/([\d,]+\.?\d+)\s*\n?\s*Remaining/i);
                const u = text.match(/([\d,]+\.?\d+)\s*\n?\s*Used/i);
                const b = text.match(/Current Balance\s*\n?\s*([\d,]+\.?\d+)/i) || text.match(/([\d,]+\.?\d+)\s*EGP/i);
                const p = text.match(/[^\n]*\d+\s*GB[^\n]*[Ss]peed[^\n]*/);
                if (!r) throw new Error('no remaining in page text');
                return { remaining: r[1], used: u?.[1]||'0', balance: b?.[1]||'0', plan: p?.[0]?.trim()||'Unknown' };
              });
              const parsed = { remaining: stripNum(result.remaining), used: stripNum(result.used)||0, balance: stripNum(result.balance)||0, plan: result.plan };
              if (!parsed.remaining) throw new Error('no data M2');
              console.log('    M2 page text regex');
              return parsed;
            },
            // M3: HTML source regex fallback
            async () => {
              await sleep(8000);
              const html = await withTimeout(page.content(), 8000, 'page.content');
              const r = html.match(/>([\d,]+\.?\d+)<[^>]*>\s*(?:<[^>]*>)*\s*Remaining/i);
              const u = html.match(/>([\d,]+\.?\d+)<[^>]*>\s*(?:<[^>]*>)*\s*Used/i);
              const b = html.match(/>([\d,]+\.?\d+)\s*EGP</i);
              if (!r) throw new Error('no data in html');
              return { remaining: stripNum(r[1]), used: stripNum(u?.[1])||0, balance: stripNum(b?.[1])||0, plan: 'Unknown' };
            }
          ], 'EXTRACT', 30000);
          
          // SUCCESS!
          console.log(`  ✓ Extraction succeeded on cycle ${cycle}!`);
          break;
          
        } catch (extractError) {
          console.log(`  ✗ Cycle ${cycle} failed: ${extractError.message}`);
          
          if (cycle < MAX_EXTRACTION_CYCLES) {
            console.log(`  ↻ Refreshing page and retrying... (${MAX_EXTRACTION_CYCLES - cycle} cycles remaining)`);
            await sleep(3000);
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
              console.log('    [WARN] Reload timeout, continuing anyway');
            });
            await sleep(5000); // Wait for dashboard to fully load after refresh
            
            // ══════════════════════════════════════
            // POST-REFRESH SESSION VERIFICATION
            // Check if reload redirected us back to login (session expired)
            // ══════════════════════════════════════
            const postRefreshUrl = page.url();
            if (postRefreshUrl.includes('/login') || postRefreshUrl.includes('#/login')) {
              console.log('  ✗ CRITICAL: Page refresh redirected to login page');
              console.log('  Session expired during extraction - saved cookies are invalid');
              
              // Clear invalid cookies
              await clearCookies();
              
              throw new Error('SESSION_EXPIRED: Refresh redirected to login - re-login required on next attempt');
            }
            
            // Verify dashboard is still present
            const postRefreshCheck = await page.evaluate(() => {
              const text = document.body.innerText;
              return text.includes('Current Balance') || text.includes('Remaining');
            });
            
            if (!postRefreshCheck) {
              console.log('  ⚠️  WARNING: Dashboard elements not found after refresh');
              console.log('  URL:', postRefreshUrl);
              console.log('  Session might be expired - will try extraction anyway');
            } else {
              console.log('  ✓ Post-refresh verification: Dashboard still loaded');
            }
            
          } else {
            // All cycles exhausted
            throw new Error(`EXTRACTION FAILED after ${MAX_EXTRACTION_CYCLES} cycles: ${extractError.message}`);
          }
        }
      }
    }
    
    if (!data) {
      throw new Error('Extraction completed but no data was captured (should not happen)');
    }

    console.log('\n  ══════════════════════════════════════');
    console.log('  📊 EXTRACTED DATA:');
    console.log('  ══════════════════════════════════════');
    console.log('  Remaining:', data.remaining, 'GB');
    console.log('  Used:', data.used, 'GB');
    console.log('  Balance:', data.balance, 'EGP');
    console.log('  Plan:', data.plan);
    console.log('  ══════════════════════════════════════\n');

    // ══════════════════════════════════════
    console.log('STEP 7: FIRESTORE');
    // ══════════════════════════════════════
    const now = new Date().toISOString();
    const fields = {
      'dokki': { mapValue: { fields: {
        quota:    { doubleValue: data.remaining },
        maxQuota: { doubleValue: data.remaining + data.used },
        balance:  { doubleValue: data.balance },
        used:     { doubleValue: data.used },
        plan:     { stringValue: data.plan },
        updatedAt: { stringValue: now },
        updatedBy: { stringValue: 'GitHub Cloud ⚡ Dokki' },
        status:   { stringValue: 'success' }
      }}},
      lastUpdate: { stringValue: now }
    };

    await tryMethods([
      async () => {
        const mask = 'updateMask.fieldPaths=dokki&updateMask.fieldPaths=lastUpdate';
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}&${mask}`;
        const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    updateMask PATCH (Dokki field)');
      },
      async () => {
        await sleep(2000);
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}`;
        const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    standard PATCH');
      },
      async () => {
        await sleep(3000);
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}`;
        const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    retry PATCH');
      }
    ], 'FIRESTORE', 20000);

    console.log('  ✓ Uploaded to quota_latest!\n');

    // ══════════════════════════════════════
    console.log('STEP 8: LEDGER (quota_history)');
    // ══════════════════════════════════════
    const historyFields = {
      timestamp: { stringValue: now },
      user: { stringValue: 'GitHub Cloud ⚡ Dokki' },
      notes: { stringValue: '' },
      dokki: { mapValue: { fields: {
        quota: { doubleValue: data.remaining },
        balance: { doubleValue: data.balance }
      }}},
      '104': { mapValue: { fields: {
        quota: { nullValue: null },
        balance: { nullValue: null }
      }}},
      gezira: { mapValue: { fields: {
        quota: { nullValue: null },
        balance: { nullValue: null }
      }}}
    };

    await tryMethods([
      async () => {
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_history?key=${FIREBASE_API_KEY}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: historyFields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    POST to quota_history');
      },
      async () => {
        await sleep(2000);
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_history?key=${FIREBASE_API_KEY}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: historyFields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    retry POST to quota_history');
      }
    ], 'LEDGER', 20000);

    console.log('  ✓ Ledger updated!\n');

    // ══════════════════════════════════════
    console.log('STEP 8.5: LOW QUOTA FLAG');
    // ══════════════════════════════════════
    // Write flag to Firestore quota_settings/alerts
    // dokki_low: true  → hourly workflow will run full harvest
    // dokki_low: false → hourly workflow will skip (normal 2h schedule handles it)
    try {
      const isLowDokki = data.remaining < 100;
      const alertFields = {
        dokki_low:       { booleanValue: isLowDokki },
        dokki_quota:     { doubleValue: data.remaining },
        dokki_updatedAt: { stringValue: now }
      };
      const alertMask = 'updateMask.fieldPaths=dokki_low&updateMask.fieldPaths=dokki_quota&updateMask.fieldPaths=dokki_updatedAt';
      const alertUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/alerts?key=${FIREBASE_API_KEY}&${alertMask}`;
      const alertRes = await fetch(alertUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: alertFields })
      });
      if (alertRes.ok) {
        console.log('  ✓ Low quota flag set: dokki_low=' + isLowDokki + ' (' + data.remaining.toFixed(1) + ' GB)\n');
      } else {
        console.log('  ⚠ Flag write failed (non-critical): HTTP ' + alertRes.status);
      }
    } catch(e) {
      console.log('  ⚠ Flag write error (non-critical):', e.message);
    }

    // ══════════════════════════════════════
    console.log('STEP 9: TELEGRAM');
    // ══════════════════════════════════════
    try {
      const date = new Date().toLocaleString('en-GB', {
        timeZone: 'Africa/Cairo',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      // Quota alert level
      const rem = data.remaining;
      let alertLine = '';
      if (rem < 30)       alertLine = '\n🚨 *CRITICAL — Under 30 GB! Recharge immediately!*';
      else if (rem < 50)  alertLine = '\n🔴 *CRITICAL — Under 50 GB!*';
      else if (rem < 100) alertLine = '\n🟠 *WARNING — Under 100 GB*';

      // Status icon based on level
      const statusIcon = rem < 50 ? '🔴' : rem < 100 ? '🟠' : '✅';

      const msg = [
        '📡 *Cairo Taj — Dokki Harvest*',
        '',
        `${statusIcon} Quota Remaining: *${rem.toFixed(2)} GB*`,
        `📉 Used: *${data.used.toFixed(2)} GB*`,
        `💰 Balance: *${data.balance.toFixed(2)} EGP*`,
        `📋 Plan: ${data.plan}`,
        `🕐 ${date}`,
        `🤖 GitHub Cloud ⚡ Dokki` + alertLine
      ].join('\n');

      const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

      // Send main harvest message to personal chat AND group (if configured)
      const recipients = [TELEGRAM_CHAT_ID];
      if (TELEGRAM_GROUP_ID) recipients.push(TELEGRAM_GROUP_ID);

      let tgSuccess = false;
      for (const chatId of recipients) {
        if (!chatId) continue;
        const tgRes = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
        });
        if (tgRes.ok) { tgSuccess = true; }
        else { console.log('  ⚠ Telegram to ' + chatId + ': HTTP ' + tgRes.status); }
      }
      if (!tgSuccess) throw new Error('All Telegram sends failed');
      console.log('  ✓ Telegram sent!\n');

      // CRITICAL ALERT: Under 30 GB — send a separate urgent message
      if (rem < 30) {
        const criticalMsg = {
          text: ['🚨🚨🚨 *CRITICAL QUOTA ALERT* 🚨🚨🚨', '', '⚠️ *Cairo Taj — Dokki*',
            `📉 Only *${rem.toFixed(2)} GB* remaining!`, '🔴 *ACTION REQUIRED: Recharge immediately!*', '', `🕐 ${date}`].join('\n'),
          parse_mode: 'Markdown',
          disable_notification: false
        };
        for (const chatId of recipients) {
          if (!chatId) continue;
          await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...criticalMsg, chat_id: chatId }) });
        }
        console.log('  🚨 Critical alert sent!\n');
      }

    } catch (e) {
      // Telegram failure should NOT fail the whole harvest
      console.log('  ⚠ Telegram failed (non-critical):', e.message);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ ✅ ✅  SUCCESS  ✅ ✅ ✅');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // ══════════════════════════════════════════════════════════════
    // VIGILANCE MODE — triggered when quota ≤ 50 GB (Dokki)
    // Stays in same session, refreshes every 13 minutes, harvests
    // until quota ≤ 2 GB or session dies (then restarts + re-switches line).
    // Only sends Telegram for Dokki — other line unaffected.
    // ══════════════════════════════════════════════════════════════
    if (data.remaining <= 50) {
      console.log('\n🔴 VIGILANCE MODE ACTIVATED (DOKKI) — quota=' + data.remaining.toFixed(2) + ' GB ≤ 50 GB');
      console.log('  Will harvest every 13 min until quota ≤ 2 GB or job time limit reached.\n');

      const VIGILANCE_INTERVAL_MS = 13 * 60 * 1000;
      const VIGILANCE_MAX_MS      = 5 * 60 * 60 * 1000 + 45 * 60 * 1000;
      const VIGILANCE_STOP_GB     = 2;
      const vigilanceStart        = Date.now();
      let   vigilanceRound        = 0;
      let   lastRemaining         = data.remaining;

      // ── Helper: refresh to account overview and re-switch to line 094 ──
      async function vigilanceRefreshPage() {
        await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
        if (page.url().includes('#/login')) throw new Error('SESSION_DIED: redirected to login');
        // Re-switch to line 094 (same logic as Step 5.5)
        await page.waitForFunction(() => {
          const t = document.body.innerText;
          return t.includes('currently managing') || t.includes('Remaining');
        }, { timeout: 15000 }).catch(() => {});
        await sleep(1500);
        const dropdowns = await page.$$('.ant-select-selector, .ant-select');
        if (dropdowns.length) {
          await dropdowns[0].click();
          await sleep(800);
        // DISMISS ANY POPUPS AFTER DROPDOWN CLICK
        console.log('    [POST-DROPDOWN] Dismissing popups...');
        await dismissAds();
        await sleep(700);
          await page.evaluate(() => {
            const opts = Array.from(document.querySelectorAll('.ant-select-item-option-content, .ant-select-item, li, option'));
            const t = opts.find(o => o.textContent && o.textContent.includes('0237600094'));
            if (t) t.click();
          });
        }
        // Wait for full 094 data (same 6-condition gate)
        for (let w = 0; w < 30; w++) {
          await sleep(1000);
          if (page.url().includes('#/login') && w > 5) throw new Error('SESSION_DIED: redirected to login after line switch');
          const check = await checkPage094();
          if (check.hasRemaining && check.has094) {
            const captured = await extractNow();
            if (captured) {
              const totalGB = (captured.remaining || 0) + (captured.used || 0);
              if (captured.balance > 3000 && captured.balance > 0 && captured.plan !== 'Unknown' && totalGB > 300) {
                console.log('  ✓ [VIGILANCE] Line 094 confirmed: rem=' + captured.remaining + ' bal=' + captured.balance);
                return captured;
              }
            }
          }
        }
        throw new Error('Line 094 data not confirmed after 30s');
      }

      // ── Helper: write to Firestore (Dokki only) ──
      async function vigilanceFirestore(vData) {
        const vNow = new Date().toISOString();
        const vFields = {
          'dokki': { mapValue: { fields: {
            quota:     { doubleValue: vData.remaining },
            maxQuota:  { doubleValue: vData.remaining + vData.used },
            balance:   { doubleValue: vData.balance },
            used:      { doubleValue: vData.used },
            plan:      { stringValue: vData.plan },
            updatedAt: { stringValue: vNow },
            updatedBy: { stringValue: 'GitHub Cloud ⚡ Dokki [VIGILANCE]' },
            status:    { stringValue: 'success' }
          }}},
          lastUpdate: { stringValue: vNow }
        };
        const mask = 'updateMask.fieldPaths=dokki&updateMask.fieldPaths=lastUpdate';
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}&${mask}`;
        const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: vFields }) });
        if (!res.ok) throw new Error('Firestore HTTP ' + res.status);
        const vHistory = {
          timestamp: { stringValue: vNow },
          user: { stringValue: 'GitHub Cloud ⚡ Dokki [VIGILANCE]' },
          notes: { stringValue: 'vigilance-mode' },
          dokki: { mapValue: { fields: { quota: { doubleValue: vData.remaining }, balance: { doubleValue: vData.balance } } } },
          '104': { mapValue: { fields: { quota: { nullValue: null }, balance: { nullValue: null } } } },
          gezira: { mapValue: { fields: { quota: { nullValue: null }, balance: { nullValue: null } } } }
        };
        const hUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_history?key=${FIREBASE_API_KEY}`;
        await fetch(hUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: vHistory }) });
      }

      // ── Helper: send Vigilance Telegram (Dokki only) ──
      async function vigilanceTelegram(vData, vRound, elapsed) {
        try {
          const rem = vData.remaining;
          const elapsedMin = Math.floor(elapsed / 60000);
          const burned = lastRemaining - rem;
          const burnRate = burned > 0 ? (burned / (elapsedMin / 60)).toFixed(2) : '0.00';
          const hoursLeft = parseFloat(burnRate) > 0 ? (rem / parseFloat(burnRate)).toFixed(1) : '∞';
          const date = new Date().toLocaleString('en-GB', {
            timeZone: 'Africa/Cairo', day: '2-digit', month: 'short',
            year: 'numeric', hour: '2-digit', minute: '2-digit'
          });
          const icon = rem <= 2 ? '🚨' : rem <= 10 ? '🔴' : rem <= 20 ? '🟠' : '🟡';
          const urgency = rem <= 2  ? '🚨 *STOP — 2 GB REACHED! Recharge NOW!*' :
                          rem <= 5  ? '🔴 *CRITICAL — Under 5 GB!*' :
                          rem <= 10 ? '🔴 *CRITICAL — Under 10 GB! Recharge soon!*' :
                          rem <= 20 ? '🟠 *WARNING — Under 20 GB*' :
                          rem <= 30 ? '🟡 *NOTICE — Under 30 GB*' : '';
          const msg = [
            '⚡ *Cairo Taj — Dokki [VIGILANCE MODE]*',
            '',
            icon + ' Quota: *' + rem.toFixed(2) + ' GB* remaining',
            '📉 Used: *' + vData.used.toFixed(2) + ' GB*',
            '💰 Balance: *' + vData.balance.toFixed(2) + ' EGP*',
            '🔥 Burn rate: ~' + burnRate + ' GB/h',
            '⏱ Est. time left: ~' + hoursLeft + 'h',
            '🔄 Vigilance round: #' + vRound + ' (' + elapsedMin + 'min in)',
            '🕐 ' + date,
            urgency
          ].filter(Boolean).join('\n');
          const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
          const recipients = [TELEGRAM_CHAT_ID];
          if (TELEGRAM_GROUP_ID) recipients.push(TELEGRAM_GROUP_ID);
          for (const chatId of recipients) {
            if (!chatId) continue;
            await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }) });
          }
          if (rem <= 10) {
            const critMsg = {
              text: ['🚨🚨🚨 *VIGILANCE CRITICAL* 🚨🚨🚨', '', '⚠️ *Cairo Taj — Dokki*',
                '📉 Only *' + rem.toFixed(2) + ' GB* remaining!',
                '🔴 *ACTION REQUIRED: Recharge immediately!*', '', '🕐 ' + date].join('\n'),
              parse_mode: 'Markdown', disable_notification: false
            };
            for (const chatId of recipients) {
              if (!chatId) continue;
              await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...critMsg, chat_id: chatId }) });
            }
          }
          console.log('  ✓ Vigilance Telegram sent (round #' + vRound + ')');
        } catch(e) { console.log('  ⚠ Vigilance Telegram failed (non-critical):', e.message); }
      }

      // ── Helper: full re-login + re-switch to 094 when session dies ──
      async function vigilanceRestartSession() {
        console.log('  [VIGILANCE] Session died — restarting fresh session...');
        try { await browser.close(); } catch(e) {}
        browser = await puppeteer.launch({
          headless: true, executablePath: '/usr/bin/google-chrome-stable',
          protocolTimeout: 60000,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                 '--disable-blink-features=AutomationControlled',
                 '--disable-features=IsolateOrigins,site-per-process','--window-size=1366,768'],
          ignoreDefaultArgs: ['--enable-automation']
        });
        page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
          window.alert = () => {}; window.confirm = () => true; window.prompt = () => '';
          Object.defineProperty(window, 'console', { writable: false, configurable: false });
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          window.navigator.chrome = { runtime: {} };
          Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        page.on('dialog', async dialog => { await dialog.accept(); });
        // Try saved cookies first
        const sc = await loadSavedCookies();
        if (sc && sc.length > 0) {
          await page.setCookie(...sc);
          await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 20000 });
          await sleep(3000);
          if (!page.url().includes('login')) {
            console.log('  [VIGILANCE] Session restored from cookies ✓');
            return;
          }
          await clearCookies();
        }
        // Full fresh login
        await tryMethods([
          async () => {
            await page.goto('https://my.te.eg/echannel/', { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 15000 });
          },
          async () => {
            await page.goto('https://my.te.eg/echannel/', { waitUntil: 'domcontentloaded', timeout: 40000 });
            await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 20000 });
          }
        ], 'VIGILANCE RE-NAVIGATE', 55000);
        await sleep(randomDelay(3000, 5000));
        await page.focus('#login_loginid_input_01').catch(() => {});
        await sleep(2000);
        await page.type('#login_loginid_input_01', WE_USERNAME, { delay: randomDelay(100, 180) });
        await sleep(randomDelay(4000, 6000));
        await page.waitForFunction(() => !!document.querySelector('.ant-select-selector, .ant-select'), { timeout: 12000 }).catch(() => {});
        await sleep(500);
        const dd = await page.$('.ant-select-selector, .ant-select');
        if (dd) { await dd.click(); await sleep(1500); }
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('.ant-select-item-option, li')) {
            if (el.textContent?.toLowerCase().includes('internet')) { el.click(); return; }
          }
        });
        await sleep(randomDelay(4000, 6000));
        await page.focus('#login_password_input_01').catch(() => {});
        await sleep(2000);
        await page.type('#login_password_input_01', WE_PASSWORD, { delay: randomDelay(100, 180) });
        await sleep(randomDelay(4000, 6000));
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('login') || b.className.includes('primary'));
          if (btn) btn.click();
        });
        for (let t = 0; t < 20; t++) {
          await sleep(1000);
          if (!page.url().includes('login')) break;
        }
        if (page.url().includes('login')) throw new Error('Re-login failed after session death');
        console.log('  [VIGILANCE] Fresh login successful ✓');
        try {
          const nc = await page.cookies();
          const rel = nc.filter(c => c.domain.includes('te.eg') || c.domain.includes('telecomegypt'));
          if (rel.length > 0) await saveCookies(rel);
        } catch(e) {}
      }

      // ══ MAIN VIGILANCE LOOP (Dokki) ══
      while (true) {
        const elapsed = Date.now() - vigilanceStart;
        if (elapsed >= VIGILANCE_MAX_MS) {
          console.log('\n[VIGILANCE] 5h 45m safety cap reached — stopping vigilance mode.');
          break;
        }
        console.log('\n[VIGILANCE] Waiting 13 minutes for next harvest...');
        await sleep(VIGILANCE_INTERVAL_MS);

        vigilanceRound++;
        const elapsedMin = Math.floor((Date.now() - vigilanceStart) / 60000);
        console.log('\n' + '═'.repeat(50));
        console.log('⚡ VIGILANCE ROUND #' + vigilanceRound + ' — DOKKI (' + elapsedMin + 'min elapsed)');
        console.log('═'.repeat(50));

        try {
          // Refresh page + re-switch to 094 (returns confirmed vData directly)
          const vData = await vigilanceRefreshPage();
          console.log('  Remaining: ' + vData.remaining + ' GB | Used: ' + vData.used + ' GB | Balance: ' + vData.balance + ' EGP');

          await vigilanceFirestore(vData);
          console.log('  ✓ Firestore + Ledger updated');

          try {
            const vNow = new Date().toISOString();
            const isLowDokki = vData.remaining < 100;
            const alertFields = {
              dokki_low: { booleanValue: isLowDokki },
              dokki_quota: { doubleValue: vData.remaining },
              dokki_updatedAt: { stringValue: vNow }
            };
            const alertMask = 'updateMask.fieldPaths=dokki_low&updateMask.fieldPaths=dokki_quota&updateMask.fieldPaths=dokki_updatedAt';
            const alertUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/alerts?key=${FIREBASE_API_KEY}&${alertMask}`;
            await fetch(alertUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: alertFields }) });
          } catch(e) { console.log('  ⚠ Flag update failed (non-critical):', e.message); }

          await vigilanceTelegram(vData, vigilanceRound, Date.now() - vigilanceStart);
          lastRemaining = vData.remaining;

          if (vData.remaining <= VIGILANCE_STOP_GB) {
            console.log('\n🚨 [VIGILANCE] Quota reached ' + vData.remaining.toFixed(2) + ' GB — STOP THRESHOLD HIT.');
            console.log('  Vigilance mode complete. Awaiting manual recharge.');
            break;
          }

        } catch (vErr) {
          console.log('  [VIGILANCE] Round #' + vigilanceRound + ' error: ' + vErr.message);
          if (vErr.message.includes('SESSION_DIED') || vErr.message.includes('redirected to login') || vErr.message.includes('ALL METHODS FAILED')) {
            console.log('  [VIGILANCE] Session dead — attempting restart...');
            try {
              await vigilanceRestartSession();
              console.log('  [VIGILANCE] Session restarted. Will retry on next round.');
            } catch (restartErr) {
              console.log('  [VIGILANCE] Restart failed: ' + restartErr.message + ' — stopping vigilance.');
              break;
            }
          } else {
            console.log('  [VIGILANCE] Non-fatal error, continuing...');
          }
        }
      }

      console.log('\n[VIGILANCE] Exiting vigilance mode after ' + vigilanceRound + ' rounds (Dokki).');
    } // end vigilance mode

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (page) {
      try {
        const ss = await withTimeout(page.screenshot({ encoding: 'base64' }), 5000, 'screenshot');
        console.log('Screenshot length:', ss.length);
        const state = await withTimeout(page.evaluate(() => ({
          url: window.location.href,
          inputs: Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, type: i.type, visible: i.offsetParent !== null })),
          bodyLen: document.body.innerHTML.length
        })), 5000, 'state');
        console.log('Page state:', JSON.stringify(state));
      } catch (e) { console.log('Diagnostics failed:', e.message); }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`\n${'═'.repeat(50)}\nATTEMPT ${attempt}/${MAX_RETRIES}\n${'═'.repeat(50)}\n`);
      await harvestQuota();
      console.log('\n🎉 COMPLETE!');
      process.exit(0);
    } catch (error) {
      console.error(`\nAttempt ${attempt} failed: ${error.message}`);
      if (error.message && error.message.includes('WE_BLOCKED')) {
        console.error('⛔ WE block detected — stopping all retries to avoid extending the block');
        console.error('💀 Will retry on next scheduled run automatically');
        process.exit(1);
      }
      if (attempt < MAX_RETRIES) {
        const d = randomDelay(30000, 45000);
        console.log(`Retrying in ${Math.floor(d/1000)}s...`);
        await sleep(d);
      } else {
        console.error('\n💀 ALL ATTEMPTS FAILED');
        process.exit(1);
      }
    }
  }
}

main();
