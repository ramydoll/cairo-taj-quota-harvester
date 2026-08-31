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
const MAX_RETRIES = 7;

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

  // ── Session Management: Save/Load ALL session data (Dokki) ────────────────
  // Saves: cookies, localStorage, sessionStorage, tokens
  // This allows skipping login entirely when session is still valid
  
  // ── Session Management ─────────────────────────────────────────────────────
  async function loadSavedSession() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.log('  [SESSION] Firestore fetch failed:', res.status); return null; }
      const doc = await res.json();
      const cookieStr = doc?.fields?.cookies?.stringValue;
      const localStr = doc?.fields?.localStorage?.stringValue;
      const sessionStr = doc?.fields?.sessionStorage?.stringValue;
      const savedAt = doc?.fields?.savedAt?.stringValue;
      if (!cookieStr || !savedAt) { console.log('  [SESSION] No session data in Firestore'); return null; }
      const age = Date.now() - new Date(savedAt).getTime();
      if (age > 8 * 60 * 60 * 1000) { console.log('  [SESSION] Session expired (>8h old), fresh login'); return null; }
      const parsed = {
        cookies: JSON.parse(cookieStr),
        localStorage: localStr ? JSON.parse(localStr) : {},
        sessionStorage: sessionStr ? JSON.parse(sessionStr) : {},
        age: Math.floor(age / 60000)
      };
      console.log(`  [SESSION] Found saved session (${parsed.age}m old) - cookies:${parsed.cookies.length} localStorage:${Object.keys(parsed.localStorage).length} sessionStorage:${Object.keys(parsed.sessionStorage).length}`);
      return parsed;
    } catch(e) { console.log('  [SESSION] Load error:', e.message); return null; }
  }

  async function saveSession(cookies, localData, sessionData) {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          cookies:        { stringValue: JSON.stringify(cookies) },
          localStorage:   { stringValue: JSON.stringify(localData) },
          sessionStorage: { stringValue: JSON.stringify(sessionData) },
          savedAt:        { stringValue: new Date().toISOString() }
        }})
      });
      console.log(`  [SESSION] Saved to Firestore - cookies:${cookies.length} localStorage:${Object.keys(localData).length} sessionStorage:${Object.keys(sessionData).length}`);
    } catch(e) { console.log('  [SESSION] Save error:', e.message); }
  }

  async function clearSession() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_dokki?key=${FIREBASE_API_KEY}`;
      await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { cookies: { stringValue: '' }, localStorage: { stringValue: '' }, sessionStorage: { stringValue: '' }, savedAt: { stringValue: '' } }})
      });
      console.log('  [SESSION] Cleared from Firestore');
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
    // STEP 0: TRY SAVED SESSION
    // ══════════════════════════════════════
    console.log('STEP 0: SESSION CHECK');
    let sessionValid = false;
    const savedSession = await loadSavedSession();
    if (savedSession && savedSession.cookies.length > 0) {
      try {
        console.log('  Restoring session (cookies + localStorage + sessionStorage)...');
        await page.setCookie(...savedSession.cookies);
        // Inject storage before navigation
        await page.evaluateOnNewDocument((localData, sessionData) => {
          try { Object.keys(localData).forEach(k => window.localStorage.setItem(k, localData[k])); } catch(e) {}
          try { Object.keys(sessionData).forEach(k => window.sessionStorage.setItem(k, sessionData[k])); } catch(e) {}
        }, savedSession.localStorage, savedSession.sessionStorage);
        await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'networkidle2', timeout: 20000 });
        await sleep(3000);
        const currentUrl = page.url();
        console.log('  [SESSION] Post-restore URL:', currentUrl);
        if (!currentUrl.includes('login') && currentUrl.includes('account')) {
          sessionValid = true;
          console.log('  ✓ Session valid! Skipping login entirely.\n');
        } else {
          console.log('  ✗ Session invalid, doing fresh login. URL:', currentUrl);
          await clearSession();
        }
      } catch(e) {
        console.log('  ✗ Session restore failed:', e.message);
        await clearSession();
      }
    } else {
      console.log('  No saved session, will do fresh login');
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
    await tryMethods([
      async () => {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.textContent.toLowerCase().includes('login') || b.className.includes('primary'));
          if (btn) btn.click();
        });
        await sleep(6000);
        console.log('    local harvester method');
      },
      async () => {
        await page.keyboard.press('Enter');
        await sleep(10000);
        console.log('    press Enter');
      },
      async () => {
        const btns = await page.$$('button');
        if (btns.length) await btns[0].click();
        await sleep(10000);
        console.log('    first button');
      },
      async () => {
        await page.click('button[type="submit"]').catch(() => {});
        await sleep(10000);
        console.log('    submit button');
      },
      async () => {
        await page.evaluate(() => { document.querySelector('form')?.submit(); });
        await sleep(10000);
        console.log('    form.submit()');
      }
    ], 'SUBMIT', 20000);

    // ======================================
    // POST-SUBMIT: Race - URL change vs captcha modal vs block
    // ======================================
    console.log('  Waiting for login result...');
    let postLoginState = 'unknown';
    for (let tick = 0; tick < 20; tick++) {
      const currentUrl = page.url();
      if (!currentUrl.includes('login')) {
        postLoginState = 'navigated';
        console.log('  [OK] URL changed to:', currentUrl);
        break;
      }
      const pageState = await page.evaluate(() => {
        const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"], [class*="verification"]');
        const text = document.body.innerText.toLowerCase();
        
        // Differentiate between T&C modal and captcha modal
        let hasCaptcha = false;
        let isTermsModal = false;
        
        if (modal) {
          // Check if it's Terms & Conditions modal (has close-terms or start-chat-modal buttons)
          isTermsModal = !!modal.querySelector('#close-terms, #start-chat-modal, .TC-content, .TC-header');
          
          // Check if it's captcha modal (has img/canvas and NOT T&C buttons)
          const hasImage = !!modal.querySelector('img, canvas');
          const hasCaptchaText = modal.innerText?.toLowerCase().includes('verification') || 
                                  modal.innerText?.toLowerCase().includes('enter code') ||
                                  modal.innerText?.toLowerCase().includes('captcha');
          
          hasCaptcha = !isTermsModal && (hasImage || hasCaptchaText);
        }
        
        // Also check body text for verification messages
        if (!hasCaptcha && (text.includes('verification') || text.includes('enter code'))) {
          hasCaptcha = true;
        }
        
        const isBlocked = text.includes('maximum') || text.includes('too many') ||
                          text.includes('exceeded') || text.includes('try again') ||
                          text.includes('blocked') || text.includes('محاولات') ||
                          text.includes('الحد الاقصى') || text.includes('مره اخرى');
        return { hasCaptcha, isTermsModal, isBlocked, text: text.slice(0, 200) };
      });
      
      // Handle Terms & Conditions modal - must ACCEPT it, not just close
      if (pageState.isTermsModal) {
        console.log('  [T&C] Terms & Conditions modal detected, accepting...');
        const accepted = await page.evaluate(() => {
          const modal = document.querySelector('.modal.show, .modal[style*="display: block"], .modal[style*="display:block"]') 
                     || document.querySelector('.TC-content')?.closest('.modal')
                     || document.querySelector('#close-terms')?.closest('.modal');
          if (!modal) return false;

          // Scroll modal to bottom first (some T&C require scroll before accept)
          const body = modal.querySelector('.modal-body, .modal-dialog-scrollable .modal-body');
          if (body) body.scrollTop = body.scrollHeight;

          // Try to find Accept/Agree/Confirm button (NOT close/dismiss)
          const allBtns = Array.from(modal.querySelectorAll('button, a.btn, input[type="button"]'));
          console.log('[T&C] Buttons found:', allBtns.map(b => b.id + '|' + b.textContent?.trim().slice(0,30)).join(' | '));

          const acceptBtn = allBtns.find(b => {
            const txt = (b.textContent || b.value || b.id || '').toLowerCase().trim();
            return txt.includes('accept') || txt.includes('agree') || txt.includes('confirm') 
                || txt.includes('ok') || txt.includes('continue') || txt.includes('proceed')
                || txt.includes('موافق') || txt.includes('قبول') || txt.includes('اوافق');
          });

          if (acceptBtn) {
            console.log('[T&C] Clicking accept button:', acceptBtn.textContent?.trim().slice(0,30));
            acceptBtn.click();
            return true;
          }

          // No accept button found - try close button as last resort
          const closeBtn = modal.querySelector('#close-terms, .close, [aria-label="Close"]');
          if (closeBtn) {
            console.log('[T&C] No accept btn found, using close button');
            closeBtn.click();
            return true;
          }
          return false;
        }).catch(() => false);

        console.log('  [T&C] Accept action result:', accepted);
        await sleep(2000);
        continue; // Continue waiting loop - do NOT re-click submit
      }
      
      if (pageState.isBlocked) {
        postLoginState = 'blocked';
        console.log('  [BLOCKED] WE has blocked this IP/account temporarily');
        console.log('  [BLOCKED] Page text:', pageState.text.slice(0, 150));
        break;
      }
      if (pageState.hasCaptcha) {
        postLoginState = 'captcha';
        console.log('  [CAPTCHA] Modal detected at', tick + 1, 'seconds');
        break;
      }
      if (tick % 3 === 0) console.log('  Waiting...', tick + 1, 's');
      await sleep(1000);
    }

    if (postLoginState === 'blocked') {
      await clearSession();
      throw new Error('WE_BLOCKED: Account/IP temporarily blocked. Will auto-retry on next scheduled run.');
    }

    if (postLoginState === 'unknown') {
      throw new Error('Still on login page - no navigation or captcha after 20s');
    }

    // ======================================
    if (postLoginState === 'captcha') {
      console.log('  [CAPTCHA] EXTREME Engine v5 - 13 filters + consensus voting\n');

      // HELPER: Find captcha image - tries multiple selectors + debugging
      async function findCaptchaImg() {
        return await page.evaluateHandle(() => {
          // Try specific captcha selectors first
          const specific = document.querySelector('.captcha-img, img[alt*="captcha"], img[alt*="Captcha"], img[src*="captcha"], img[src*="verify"], img[src*="code"]');
          if (specific && specific.naturalWidth > 0) {
            console.log('[IMG] Found via specific selector:', specific.src?.slice(0,50));
            return specific;
          }
          
          // Find modal first
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"], [class*="Modal"]');
          if (!modal) {
            console.log('[IMG] No modal found!');
            return null;
          }
          
          // Log all images in modal for debugging
          const allImgs = Array.from(modal.querySelectorAll('img'));
          console.log('[IMG] Found', allImgs.length, 'images in modal');
          allImgs.forEach((img, i) => {
            const r = img.getBoundingClientRect();
            console.log(`[IMG ${i}] src=${img.src?.slice(0,40)} size=${r.width}x${r.height} natural=${img.naturalWidth}x${img.naturalHeight} visible=${img.offsetParent!==null}`);
          });
          
          // Sort by size and find largest valid image
          const imgs = allImgs.filter(img => {
            const r = img.getBoundingClientRect();
            return r.width > 50 && r.height > 20 && img.offsetParent !== null;
          });
          
          imgs.sort((a, b) => {
            const aR = a.getBoundingClientRect(), bR = b.getBoundingClientRect();
            return (bR.width * bR.height) - (aR.width * aR.height);
          });
          
          for (const img of imgs) {
            // Wait a bit for image to load if naturalWidth is 0
            if (img.naturalWidth === 0) {
              console.log('[IMG] Image not loaded yet, src:', img.src?.slice(0,40));
              continue;
            }
            const r = img.getBoundingClientRect();
            if (r.width > 80 && r.height > 25 && img.naturalWidth > 0) {
              console.log('[IMG] Selected image:', img.src?.slice(0,50), `size=${r.width}x${r.height}`);
              return img;
            }
          }
          
          console.log('[IMG] No valid image found after filtering');
          return null;
        });
      }

      // HELPER: 10 BLUE LINE KILLER filters at 4x scale
      async function canvasProcess(imgHandle, filter) {
        return await page.evaluate((imgEl, f) => {
          if (!imgEl || !imgEl.naturalWidth) return null;
          const scale = 4;
          const c = document.createElement('canvas');
          c.width = imgEl.naturalWidth * scale;
          c.height = imgEl.naturalHeight * scale;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(imgEl, 0, 0, c.width, c.height);
          const data = ctx.getImageData(0, 0, c.width, c.height);
          const d = data.data;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i+1], b = d[i+2];
            let keep = false;
            const isBlue = b > 100 && b > r + 20 && b > g + 20;
            const isGray = Math.abs(r-g) < 20 && Math.abs(g-b) < 20 && Math.abs(r-b) < 20;
            if (f === 'redOnly')       { keep = r > 80 && (r-g) > 25 && (r-b) > 25 && !isBlue; }
            else if (f === 'redStrict'){ keep = r > 120 && (r-g) > 50 && (r-b) > 50 && !isBlue; }
            else if (f === 'redWide')  { keep = r > 60 && (r-g) > 15 && (r-b) > 15 && !isBlue; }
            else if (f === 'megaRed')  { keep = r > 70 && r > g+20 && r > b+20 && b < 120; }
            else if (f === 'darkNoBlue') { const lum=0.299*r+0.587*g+0.114*b; keep=lum<140&&!isBlue; }
            else if (f === 'saturationBoost') { const max=Math.max(r,g,b),min=Math.min(r,g,b),sat=max===0?0:(max-min)/max; keep=sat>0.4&&r>g&&r>b&&!isBlue; }
            else if (f === 'warmColors') { keep = (r>g+15)&&(r>b+15)&&(r+g>b*1.5)&&!isBlue; }
            else if (f === 'antiBlue') { keep = !isBlue && !isGray; }
            else if (f === 'colorOnly') { const max=Math.max(r,g,b),min=Math.min(r,g,b),sat=max===0?0:(max-min)/max; keep=sat>0.3&&r>b&&!isBlue; }
            else if (f === 'notBlueNotGray') { keep = !isBlue && !(isGray && r > 140); }
            else if (f === 'blueInverter') { const blueness=b-Math.max(r,g); keep=blueness<-20; }
            else if (f === 'channelDivide') { const ratio=b>0?r/b:r; keep=ratio>1.5&&r>40; }
            else if (f === 'hsvIsolation') { const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min; let hue=0; if(delta>0){if(max===r)hue=((g-b)/delta+(g<b?6:0))*60;else if(max===g)hue=((b-r)/delta+2)*60;else hue=((r-g)/delta+4)*60;} const sat=max===0?0:delta/max; keep=((hue>=0&&hue<=50&&sat>0.3)||(sat<0.3&&max<140))&&max>20; }
            d[i] = d[i+1] = d[i+2] = keep ? 0 : 255;
            d[i+3] = 255;
          }
          ctx.putImageData(data, 0, 0);
          return c.toDataURL('image/png');
        }, imgHandle, filter);
      }

      // HELPER: 4 PSM modes - NO character corrections (trust OCR as-is)
      async function ocrRead(imageData) {
        const Tesseract = require('tesseract.js');
        const results = [];
        for (const mode of ['8','7','6','13']) {
          try {
            const r = await Tesseract.recognize(imageData, 'eng', {
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
              tessedit_pageseg_mode: mode
            });
            // Raw OCR - NO corrections - trust what Tesseract reads
            const text = r.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
            if (text && text.length >= 4 && text.length <= 6) results.push(text);
          } catch(e) {}
        }
        return [...new Set(results)];
      }

      // HELPER: Submit captcha answer
      async function submitAnswer(answer) {
        console.log('    -> Submitting:', answer);
        const ok = await page.evaluate((ans) => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          if (!modal) return false;
          const inp = modal.querySelector('input.ant-input, input[type="text"]');
          if (!inp) return false;
          inp.focus(); inp.click();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ''); inp.dispatchEvent(new Event('input', { bubbles: true }));
          setter.call(inp, ans); inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          const allBtns = Array.from(modal.querySelectorAll('button'));
          const btn = allBtns.find(b => /ok|confirm|submit/i.test(b.textContent)) ||
                      modal.querySelector('button.ant-btn-primary') ||
                      allBtns[allBtns.length - 1];
          if (btn) btn.click();
          return true;
        }, answer);
        if (!ok) {
          await page.keyboard.press('Tab'); await sleep(200);
          await page.keyboard.type(answer, { delay: 40 }); await sleep(300);
          await page.keyboard.press('Enter');
        }
        await sleep(5000);
        return !page.url().includes('login');
      }

      // HELPER: Check if modal is still open
      async function isModalOpen() {
        return await page.evaluate(() => !!document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]'));
      }

      // MAIN EXTREME CAPTCHA LOOP - 12 rounds, 13 filters, consensus voting
      const FILTERS = ['redOnly','megaRed','redStrict','redWide','darkNoBlue','saturationBoost','warmColors','antiBlue','colorOnly','notBlueNotGray','blueInverter','channelDivide','hsvIsolation'];
      let captchaSolved = false;

      for (let round = 1; round <= 12 && !captchaSolved; round++) {
        console.log('  -- Round', round, '/ 12 --');

        if (round > 1) {
          let modalFound = false;
          for (let w = 0; w < 10; w++) {
            await sleep(1000);
            if (await isModalOpen()) { modalFound = true; break; }
            if (!page.url().includes('login')) { captchaSolved = true; console.log('  [OK] Login succeeded!'); break; }
          }
          if (captchaSolved) break;
          if (!modalFound) {
            // WE closed the modal after wrong answer - need full page reload + re-login
            console.log('    Modal closed - doing full page reload...');
            await page.goto('https://my.te.eg/echannel/', { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForFunction(() => document.querySelectorAll('input').length >= 2, { timeout: 15000 });
            await sleep(3000);
            // Re-enter credentials
            await page.focus('#login_loginid_input_01');
            await sleep(1000);
            await page.type('#login_loginid_input_01', WE_USERNAME, { delay: 120 });
            await sleep(2000);
            // Re-select dropdown
            const dropdown = await page.$('.ant-select-selector, .ant-select');
            if (dropdown) {
              await dropdown.click(); await sleep(1500);
              await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.ant-select-item-option, .ant-select-item, li'));
                const internet = items.find(i => i.textContent.toLowerCase().includes('internet'));
                if (internet) internet.click();
              });
              await sleep(1000);
            }
            // Re-enter password
            await page.focus('#login_password_input_01');
            await sleep(1000);
            await page.type('#login_password_input_01', WE_PASSWORD, { delay: 120 });
            await sleep(2000);
            // Re-submit
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const btn = btns.find(b => b.textContent.toLowerCase().includes('login') || b.className.includes('primary'));
              if (btn) btn.click();
            });
            await sleep(6000);
            // Check for new captcha
            const nowOpen = await isModalOpen();
            if (!nowOpen) {
              if (!page.url().includes('login')) { captchaSolved = true; break; }
              console.log('    ! No captcha after reload, skipping round'); continue;
            }
            console.log('    New captcha appeared after reload!');
          }
          await sleep(1000);
        }

        try {
          // Wait up to 15s for captcha image WITH LONGER RETRIES
          let imgHandle = null;
          for (let retry = 0; retry < 30; retry++) {
            imgHandle = await findCaptchaImg();
            const isValid = await page.evaluate(el => el && el.naturalWidth > 0, imgHandle).catch(() => false);
            if (isValid) break;
            imgHandle = null; 
            await sleep(500); // Check every 500ms instead of 1s
          }
          if (!imgHandle) { 
            console.log('    ! No valid captcha image after 15s');
            // Dump modal HTML for debugging
            const modalHtml = await page.evaluate(() => {
              const m = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
              return m ? m.innerHTML.slice(0, 500) : 'NO MODAL';
            });
            console.log('    [DEBUG] Modal HTML:', modalHtml);
            continue; 
          }

          // STUDY: Process with all 13 filters
          let allAnswers = [];
          console.log('    [STUDY] Processing with all 13 filters...');
          for (const filter of FILTERS) {
            const b64 = await canvasProcess(imgHandle, filter);
            if (!b64) continue;
            const texts = await ocrRead(b64);
            for (const text of texts) if (text.length >= 4 && text.length <= 6) allAnswers.push({ filter, text });
            if (texts.length > 0) console.log('      [' + filter + ']:', texts.join(', '));
          }

          if (allAnswers.length === 0) { console.log('    ! No candidates found'); continue; }

          // CONSENSUS: Pick most frequent answer
          const freq = {};
          allAnswers.forEach(a => { const k = a.text; freq[k] = (freq[k]||0) + 1; });
          // Also count case-insensitive groups
          const freqLower = {};
          allAnswers.forEach(a => { const k = a.text.toLowerCase(); freqLower[k] = (freqLower[k]||0) + 1; });
          let bestLower = '', maxCount = 0;
          for (const [ans, count] of Object.entries(freqLower)) {
            console.log('      "' + ans + '" x' + count);
            if (count > maxCount || (count === maxCount && ans.length === 5)) { maxCount = count; bestLower = ans; }
          }
          // Find the most common casing for this answer
          const casings = allAnswers.filter(a => a.text.toLowerCase() === bestLower).map(a => a.text);
          const casingFreq = {};
          casings.forEach(c => { casingFreq[c] = (casingFreq[c]||0) + 1; });
          const best = Object.entries(casingFreq).sort((a,b) => b[1]-a[1])[0][0];
          console.log('    [CONSENSUS] Best: "' + best + '" (' + maxCount + ' votes)');

          // Submit ONLY the consensus answer - WE allows very few attempts!
          // Try: exact casing first, then UPPER, then lower
          const variants = [...new Set([best, best.toUpperCase(), best.toLowerCase()])];
          console.log('    [VARIANTS] Will try:', variants.join(', '));

          for (const attempt of variants) {
            console.log('    -> Trying:', attempt);
            captchaSolved = await submitAnswer(attempt);
            if (captchaSolved) { console.log('  >>> CAPTCHA SOLVED with "' + attempt + '" on round', round, '! <<<'); break; }
            else { console.log('    X Wrong: "' + attempt + '"'); await sleep(2000); if (!await isModalOpen()) break; }
          }
        } catch (e) {
          console.log('    ! Error:', e.message);
        }
      }

      if (!captchaSolved) {
        await page.evaluate(() => {
          const modal = document.querySelector('.ant-modal-content, .ant-modal, [class*="modal"]');
          const btn = modal?.querySelector('button');
          if (btn) btn.click();
        });
        await sleep(2000);
        throw new Error('Captcha unsolvable after 12 rounds - retrying login');
      }
    }

    // ══════════════════════════════════════
    console.log('STEP 2: SERVICE NUMBER (USERNAME)');
    // ══════════════════════════════════════
    console.log('  ✓ Login successful!\n');

    // Save full session after successful login
    try {
      const cookies = await page.cookies();
      const relevantCookies = cookies.filter(c => c.domain.includes('te.eg') || c.domain.includes('telecomegypt'));
      const storageData = await page.evaluate(() => {
        const local = {}, session = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); local[k] = localStorage.getItem(k); } } catch(e) {}
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); session[k] = sessionStorage.getItem(k); } } catch(e) {}
        return { local, session };
      });
      if (relevantCookies.length > 0) {
        await saveSession(relevantCookies, storageData.local, storageData.session);
      }
    } catch(e) { console.log('  [SESSION] Could not save session:', e.message); }

    } // end if (!sessionValid)


    // ══════════════════════════════════════
    console.log('STEP 5.5: LINE SWITCHER (Dokki)');
    // ══════════════════════════════════════
    console.log('  Switching to line 0237600094...');

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
        await sleep(1500);

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
    console.log('STEP 6: EXTRACT');
    // ══════════════════════════════════════

    // Use pre-captured data from switcher if available (avoids race condition with redirect)
    // Only fall through to live extraction if switcher didn't capture data
    const data = switcherCapturedData ? await (async () => {
      console.log('  [FAST PATH] Using data captured during line switch (race-condition safe)');
      console.log('    M1 numeric-only sibling scan');
      return switcherCapturedData;
    })() : await tryMethods([
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

    console.log('  Remaining:', data.remaining, 'GB');
    console.log('  Used:', data.used, 'GB');
    console.log('  Balance:', data.balance, 'EGP');
    console.log('  Plan:', data.plan, '\n');

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
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ ✅ ✅  SUCCESS  ✅ ✅ ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎉 COMPLETE!');
      process.exit(0);
    } catch (error) {
      console.error(`\nAttempt ${attempt} failed: ${error.message}`);
      
      // Screenshot on error for debugging
      if (error.screenshot) {
        console.log(`Screenshot length: ${error.screenshot.length}`);
      }
      
      // If WE blocked us, don't retry — it will make things worse
      if (error.message && error.message.includes('WE_BLOCKED')) {
        console.error('⛔ WE block detected — stopping all retries to avoid extending the block period');
        console.error('💀 Will retry on next scheduled run automatically');
        
        // Send Telegram alert for WE block
        try {
          const msg = `🚨 Dokki BLOCKED by WE\n\nWE has temporarily blocked this account/IP.\nWill auto-retry in 2 hours.\n\nTime: ${new Date().toLocaleString('en-US', {timeZone: 'Africa/Cairo'})} Cairo`;
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
          });
        } catch (e) { console.error('Could not send Telegram alert:', e.message); }
        
        process.exit(1);
      }
      
      // Check if this is a credentials issue
      if (error.message && (error.message.includes('Still on login page') || error.message.includes('navigation or captcha'))) {
        console.error('⚠️  Login issue detected - credentials may be wrong or account locked');
        
        // Only send alert on last attempt to avoid spam
        if (attempt === MAX_RETRIES) {
          try {
            const msg = `⚠️ Dokki Login Failed (All ${MAX_RETRIES} Attempts)\n\nIssue: ${error.message}\n\nCheck GitHub Actions logs for details.\n\nTime: ${new Date().toLocaleString('en-US', {timeZone: 'Africa/Cairo'})} Cairo`;
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
            });
          } catch (e) { console.error('Could not send Telegram alert:', e.message); }
        }
      }
      
      if (attempt < MAX_RETRIES) {
        // Smart backoff: progressive delay to avoid rate limiting
        // Attempt 1: 30-45s, Attempt 2: 45-60s, Attempt 3: 60-75s, etc.
        const baseDelay = 30000 + ((attempt - 1) * 15000);
        const variance = 15000;
        const delay = baseDelay + Math.floor(Math.random() * variance);
        console.log(`Retrying in ${Math.floor(delay/1000)}s... (smart backoff)`);
        await sleep(delay);
      } else {
        console.error('\n💀 ALL ATTEMPTS FAILED');
        process.exit(1);
      }
    }
  }
}

main();
