const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch');

puppeteer.use(StealthPlugin());

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const WE_USERNAME = process.env.WE_USERNAME;
const WE_PASSWORD = process.env.WE_PASSWORD;
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
      console.log(`  ظ£ô Method ${i+1} SUCCESS`);
      return result;
    } catch (e) {
      console.log(`  ظ£ù Method ${i+1} FAILED: ${e.message}`);
      if (i === methods.length - 1) throw new Error(`${stepName} ALL METHODS FAILED`);
      await sleep(500);
    }
  }
}

async function harvestQuota() {
  console.log('≡اأ STARTING...\n');
  let browser, page;

  // ظ¤ظ¤ Session Management: Save/Load ALL session data ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤
  // Saves: cookies, localStorage, sessionStorage, tokens
  // This allows skipping login entirely when session is still valid
  
  // ظ¤ظ¤ Session Management ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤
  async function loadSavedSession() {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
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
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
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
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/session_104?key=${FIREBASE_API_KEY}`;
      await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { cookies: { stringValue: '' }, localStorage: { stringValue: '' }, sessionStorage: { stringValue: '' }, savedAt: { stringValue: '' } }})
      });
      console.log('  [SESSION] Cleared from Firestore');
    } catch(e) {}
  }
  // ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤

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

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    // STEP 0: TRY SAVED SESSION
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
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
          console.log('  ظ£ô Session valid! Skipping login entirely.\n');
        } else {
          console.log('  ظ£ù Session invalid, doing fresh login. URL:', currentUrl);
          await clearSession();
        }
      } catch(e) {
        console.log('  ظ£ù Session restore failed:', e.message);
        await clearSession();
      }
    } else {
      console.log('  No saved session, will do fresh login');
    }

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 1: NAVIGATE');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
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
      // Check for captcha OR block message
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
        
        // Detect WE block messages
        const isBlocked = text.includes('maximum') || text.includes('too many') ||
                          text.includes('exceeded') || text.includes('try again') ||
                          text.includes('blocked') || text.includes('┘à╪ص╪د┘ê┘╪د╪ز') ||
                          text.includes('╪د┘╪ص╪» ╪د┘╪د┘é╪╡┘ë') || text.includes('┘à╪▒┘ç ╪د╪«╪▒┘ë');
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
                || txt.includes('┘à┘ê╪د┘┘é') || txt.includes('┘é╪ذ┘ê┘') || txt.includes('╪د┘ê╪د┘┘é');
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

    // Handle blocked state ظ¤ clear cookies and exit cleanly (don't retry)
    if (postLoginState === 'blocked') {
      await clearSession(); // Clear any saved session
      throw new Error('WE_BLOCKED: Account/IP temporarily blocked. Will auto-retry on next scheduled run (2h).');
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

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 2: SERVICE NUMBER (USERNAME)');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('  ظ£ô Login successful!\n');

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

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 6: EXTRACT');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    const data = await tryMethods([
      // M1: Walk ALL spans/divs, find ones whose text is ONLY a decimal number,
      // then check if a nearby sibling contains "Remaining" or "Used"
      async () => {
        await sleep(2000);
        // Wait for balance card to load (extra wait if balance not yet visible)
        await withTimeout(
          page.waitForFunction(() => {
            const text = document.body.innerText;
            return text.includes('Current Balance') && /[\d,]+\.?\d+\s*EGP/.test(text);
          }, { timeout: 8000 }),
          9000, 'balance card wait'
        ).catch(() => console.log('    [WARN] Balance card slow, proceeding anyway'));

        const result = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span, div, p'));
          let remaining = null, used = null, balance = null, plan = null;

          // Helper: is this text a plain decimal number (with optional commas)?
          function isNumericText(t) {
            if (!t) return false;
            const stripped = t.replace(/,/g, '').trim();
            return /^\d+(\.\d+)?$/.test(stripped) && !stripped.startsWith('0237') && !stripped.startsWith('023');
          }

          for (let i = 0; i < spans.length; i++) {
            const t = spans[i].innerText?.trim();
            if (!t || t.length > 100) continue;

            // Find "Remaining" label ظ¤ check i-1, i-2 for the number
            if (t === 'Remaining') {
              for (let back = 1; back <= 3; back++) {
                if (i - back >= 0) {
                  const candidate = spans[i - back].innerText?.trim();
                  if (isNumericText(candidate)) { remaining = candidate; break; }
                }
              }
            }

            // Find "Used" label ظ¤ check i-1, i-2 for the number
            if (t === 'Used') {
              for (let back = 1; back <= 3; back++) {
                if (i - back >= 0) {
                  const candidate = spans[i - back].innerText?.trim();
                  if (isNumericText(candidate)) { used = candidate; break; }
                }
              }
            }

            // Balance: "Current Balance" label then look forward for EGP number
            if (t === 'Current Balance') {
              for (let fwd = 1; fwd <= 8; fwd++) {
                if (i + fwd < spans.length) {
                  const candidate = spans[i + fwd].innerText?.trim();
                  if (isNumericText(candidate)) { balance = candidate; break; }
                }
              }
            }

            // Plan: contains "GB" and "Speed"
            if (t.includes('GB') && t.toLowerCase().includes('speed')) plan = t;
          }

          // Fallback: if balance still not found, try regex on full page text
          if (!balance) {
            const text = document.body.innerText;
            const bMatch = text.match(/Current Balance\s*[\n\r\s]*([\d,]+\.?\d+)/i)
                        || text.match(/([\d,]+\.?\d+)\s*EGP/i);
            if (bMatch) balance = bMatch[1];
          }

          if (!remaining) throw new Error('no remaining found');
          return { remaining, used: used||'0', balance: balance||'0', plan: plan||'Unknown' };
        });
        const parsed = {
          remaining: stripNum(result.remaining),
          used: stripNum(result.used) || 0,
          balance: stripNum(result.balance) || 0,
          plan: result.plan
        };
        if (!parsed.remaining && parsed.remaining !== 0) throw new Error('no data after stripNum');
        console.log('    M1 numeric-only sibling scan');
        return parsed;
      },
      // M2: innerText of whole page, regex number BEFORE label word (on same or adjacent line)
      async () => {
        await sleep(5000);
        const result = await page.evaluate(() => {
          const text = document.body.innerText;
          // The page renders: "1,391.34\nRemaining" or "1,391.34 Remaining"
          const r = text.match(/([\d,]+\.?\d+)\s*\n?\s*Remaining/i);
          const u = text.match(/([\d,]+\.?\d+)\s*\n?\s*Used/i);
          const b = text.match(/Current Balance\s*\n?\s*([\d,]+\.?\d+)/i)
                 || text.match(/([\d,]+\.?\d+)\s*EGP/i);
          const p = text.match(/[^\n]*\d+\s*GB[^\n]*[Ss]peed[^\n]*/);
          if (!r) throw new Error('no remaining in page text');
          return {
            remaining: r[1],
            used: u?.[1] || '0',
            balance: b?.[1] || '0',
            plan: p?.[0]?.trim() || 'Unknown'
          };
        });
        const parsed = {
          remaining: stripNum(result.remaining),
          used: stripNum(result.used) || 0,
          balance: stripNum(result.balance) || 0,
          plan: result.plan
        };
        if (!parsed.remaining) throw new Error('no data M2');
        console.log('    M2 page text regex number-before-label');
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
        return {
          remaining: stripNum(r[1]),
          used: stripNum(u?.[1]) || 0,
          balance: stripNum(b?.[1]) || 0,
          plan: 'Unknown'
        };
      }
    ], 'EXTRACT', 30000);

    console.log('  Remaining:', data.remaining, 'GB');
    console.log('  Used:', data.used, 'GB');
    console.log('  Balance:', data.balance, 'EGP');
    console.log('  Plan:', data.plan, '\n');

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 7: FIRESTORE');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    const now = new Date().toISOString();
    const fields = {
      '104': { mapValue: { fields: {
        quota:    { doubleValue: data.remaining },
        maxQuota: { doubleValue: data.remaining + data.used },
        balance:  { doubleValue: data.balance },
        used:     { doubleValue: data.used },
        plan:     { stringValue: data.plan },
        updatedAt: { stringValue: now },
        updatedBy: { stringValue: 'GitHub Cloud ظأة' },
        status:   { stringValue: 'success' }
      }}},
      lastUpdate: { stringValue: now }
    };

    await tryMethods([
      async () => {
        const mask = 'updateMask.fieldPaths=%60104%60&updateMask.fieldPaths=lastUpdate';
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_latest/current?key=${FIREBASE_API_KEY}&${mask}`;
        const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log('    updateMask PATCH (same as local harvester)');
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

    console.log('  ظ£ô Uploaded to quota_latest!\n');

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 8: LEDGER (quota_history)');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    const historyFields = {
      timestamp: { stringValue: now },
      user: { stringValue: 'GitHub Cloud ظأة' },
      notes: { stringValue: '' },
      dokki: { mapValue: { fields: {
        quota: { nullValue: null },
        balance: { nullValue: null }
      }}},
      '104': { mapValue: { fields: {
        quota: { doubleValue: data.remaining },
        balance: { doubleValue: data.balance }
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

    console.log('  ظ£ô Ledger updated!\n');

    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 8.5: LOW QUOTA FLAG');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    // Write flag to Firestore quota_settings/alerts
    // line104_low: true  ظْ hourly workflow will run full harvest
    // line104_low: false ظْ hourly workflow will skip (normal 2h schedule handles it)
    try {
      const isLow104 = data.remaining < 100;
      const alertFields = {
        line104_low:  { booleanValue: isLow104 },
        line104_quota: { doubleValue: data.remaining },
        line104_updatedAt: { stringValue: now }
      };
      const alertMask = 'updateMask.fieldPaths=line104_low&updateMask.fieldPaths=line104_quota&updateMask.fieldPaths=line104_updatedAt';
      const alertUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/quota_settings/alerts?key=${FIREBASE_API_KEY}&${alertMask}`;
      const alertRes = await fetch(alertUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: alertFields })
      });
      if (alertRes.ok) {
        console.log('  ظ£ô Low quota flag set: line104_low=' + isLow104 + ' (' + data.remaining.toFixed(1) + ' GB)\n');
      } else {
        console.log('  ظأب Flag write failed (non-critical): HTTP ' + alertRes.status);
      }
    } catch(e) {
      console.log('  ظأب Flag write error (non-critical):', e.message);
    }    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    console.log('STEP 9: TELEGRAM');
    // ظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـظـ
    try {
      const date = new Date().toLocaleString('en-GB', {
        timeZone: 'Africa/Cairo',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      // Quota alert level
      const rem = data.remaining;
      let alertLine = '';
      if (rem < 30)       alertLine = '\n≡اأذ *CRITICAL ظ¤ Under 30 GB! Recharge immediately!*';
      else if (rem < 50)  alertLine = '\n≡ا¤┤ *CRITICAL ظ¤ Under 50 GB!*';
      else if (rem < 100) alertLine = '\n≡ااب *WARNING ظ¤ Under 100 GB*';

      // Status icon based on level
      const statusIcon = rem < 50 ? '≡ا¤┤' : rem < 100 ? '≡ااب' : 'ظ£à';

      const msg = [
        '≡اôة *Cairo Taj ظ¤ Line 104 Harvest*',
        '',
        `${statusIcon} Quota Remaining: *${rem.toFixed(2)} GB*`,
        `≡اôë Used: *${data.used.toFixed(2)} GB*`,
        `≡اْ░ Balance: *${data.balance.toFixed(2)} EGP*`,
        `≡اôï Plan: ${data.plan}`,
        `≡اـ ${date}`,
        `≡اجû GitHub Cloud ظأة` + alertLine
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
        else { console.log('  ظأب Telegram to ' + chatId + ': HTTP ' + tgRes.status); }
      }
      if (!tgSuccess) throw new Error('All Telegram sends failed');
      console.log('  ظ£ô Telegram sent!\n');

      // CRITICAL ALERT: Under 30 GB ظ¤ send a separate urgent message
      // This triggers a second notification/ringtone on the phone
      if (rem < 30) {
        const criticalMsg = {
          text: ['≡اأذ≡اأذ≡اأذ *CRITICAL QUOTA ALERT* ≡اأذ≡اأذ≡اأذ', '', 'ظأبي╕ *Cairo Taj ظ¤ Line 104*',
            `≡اôë Only *${rem.toFixed(2)} GB* remaining!`, '≡ا¤┤ *ACTION REQUIRED: Recharge immediately!*', '', `≡اـ ${date}`].join('\n'),
          parse_mode: 'Markdown',
          disable_notification: false
        };
        for (const chatId of recipients) {
          if (!chatId) continue;
          await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...criticalMsg, chat_id: chatId }) });
        }
        console.log('  ≡اأذ Critical alert sent!\n');
      }

    } catch (e) {
      // Telegram failure should NOT fail the whole harvest
      console.log('  ظأب Telegram failed (non-critical):', e.message);
    }
    console.log('ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤');
    console.log('ظ£à ظ£à ظ£à  SUCCESS  ظ£à ظ£à ظ£à');
    console.log('ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤');

  } catch (error) {
    console.error('\nظإî ERROR:', error.message);
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
      console.log(`\n${'ظـ'.repeat(50)}\nATTEMPT ${attempt}/${MAX_RETRIES}\n${'ظـ'.repeat(50)}\n`);
      await harvestQuota();
      console.log('\nظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤\nظ£à ظ£à ظ£à  SUCCESS  ظ£à ظ£à ظ£à\nظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤ظ¤\n≡اë COMPLETE!');
      process.exit(0);
    } catch (error) {
      console.error(`\nAttempt ${attempt} failed: ${error.message}`);
      
      // Screenshot on error for debugging
      if (error.screenshot) {
        console.log(`Screenshot length: ${error.screenshot.length}`);
      }
      
      // If WE blocked us, don't retry ظ¤ it will make things worse
      if (error.message && error.message.includes('WE_BLOCKED')) {
        console.error('ظؤ¤ WE block detected ظ¤ stopping all retries to avoid extending the block period');
        console.error('≡اْ Will retry on next scheduled run automatically');
        
        // Send Telegram alert for WE block
        try {
          const msg = `≡اأذ Line 104 BLOCKED by WE\n\nWE has temporarily blocked this account/IP.\nWill auto-retry in 2 hours.\n\nTime: ${new Date().toLocaleString('en-US', {timeZone: 'Africa/Cairo'})} Cairo`;
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
        console.error('ظأبي╕  Login issue detected - credentials may be wrong or account locked');
        
        // Only send alert on last attempt to avoid spam
        if (attempt === MAX_RETRIES) {
          try {
            const msg = `ظأبي╕ Line 104 Login Failed (All ${MAX_RETRIES} Attempts)\n\nIssue: ${error.message}\n\nCheck GitHub Actions logs for details.\n\nTime: ${new Date().toLocaleString('en-US', {timeZone: 'Africa/Cairo'})} Cairo`;
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
        console.error('\n≡اْ ALL ATTEMPTS FAILED');
        process.exit(1);
      }
    }
  }
}

main();
