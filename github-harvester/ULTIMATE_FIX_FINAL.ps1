# ULTIMATE FIX - Based on manual login screenshots analysis
# Problem: WE has anti-bot that detects automation and disables the button
# Solution: Add delays for server validation + mouse movements + proper React triggering

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "e:\Proj work\getclone\github-harvester\BACKUP_ULTIMATE_FINAL_$timestamp"

Write-Host "Creating backup..."
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item "e:\Proj work\getclone\github-harvester\harvester.js" -Destination $backupDir
Copy-Item "e:\Proj work\getclone\github-harvester\harvester-dokki.js" -Destination $backupDir

Write-Host "Backup created: $backupDir"
Write-Host ""
Write-Host "Applying ULTIMATE fixes..."

# Read harvester.js
$content = Get-Content "e:\Proj work\getclone\github-harvester\harvester.js" -Raw

# FIX 1: Add delay after service number for WE server validation
$content = $content -replace `
'console\.log\(''  \[HUMAN\] pause'', delay2, ''ms''\);
    await sleep\(delay2\);

    // Wait for dropdown to appear after username triggers React re-render',
'console.log(''  [HUMAN] pause'', delay2, ''ms'');
    await sleep(delay2);

    // CRITICAL: WE validates service number server-side before enabling dropdown
    console.log(''  [WAIT] Waiting for WE server validation...'');
    await sleep(3000); // Server validation delay
    
    // Wait for dropdown to appear after username triggers React re-render'

# FIX 2: Add longer wait after dropdown selection for React state
$content = $content -replace `
'await sleep\(1000\);
    }

    console\.log\(''  \[OK\] Dropdown done\\n''\);',
'await sleep(1000);
    }

    console.log(''  [OK] Dropdown done'');
    
    // CRITICAL: Wait for React to update form state with dropdown selection
    console.log(''  [WAIT] Waiting for React form state update...'');
    await sleep(2000);
    console.log(''  [OK] Form state updated\n'');'

# FIX 3: Replace button click with mouse movement + real click
$oldSubmit = @'
    // PROGRESSIVE SUBMISSION - Try ONE method at a time, wait for response
    let loginTriggered = false;
    
    // METHOD 1: Standard button click
    if (!loginTriggered) {
      console.log('  [SUBMIT] METHOD 1: Button click with validation');
      const result1 = await page.evaluate(() => {
        // Trigger validation
        const inputs = document.querySelectorAll('input');
        inputs.forEach(inp => {
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        // Click button
        const btns = Array.from(document.querySelectorAll('button'));
        const loginBtn = btns.find(b => b.textContent.toLowerCase().includes('login'));
        
        if (!loginBtn) return { success: false, reason: 'No button' };
        
        loginBtn.disabled = false;
        loginBtn.click();
        
        return { success: true, text: loginBtn.textContent.trim() };
      });
      console.log('    Result:', JSON.stringify(result1));
'@

$newSubmit = @'
    // ULTIMATE SUBMISSION - Mouse movement + real click to bypass anti-bot
    console.log('  [ANTI-BOT] Adding human-like mouse movement...');
    
    // Get button coordinates
    const loginButton = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.toLowerCase().includes('login'));
    });
    
    if (!loginButton) {
      throw new Error('Login button not found');
    }
    
    const box = await loginButton.boundingBox();
    if (box) {
      // Move mouse to button (human-like)
      console.log('  [MOUSE] Moving to button...');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await sleep(500);
    }
    
    // Trigger all validation events
    console.log('  [VALIDATE] Triggering form validation...');
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      inputs.forEach(inp => {
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
      
      // Trigger form validation
      const form = document.querySelector('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    await sleep(1000);
    
    // Use Puppeteer's real click (bypasses anti-bot)
    console.log('  [SUBMIT] METHOD 1: Real mouse click');
    let loginTriggered = false;
    
    try {
      await loginButton.click({ delay: 100 });
      console.log('    Clicked with mouse');
'@

$content = $content -replace [regex]::Escape($oldSubmit), $newSubmit

# Save
Set-Content -Path "e:\Proj work\getclone\github-harvester\harvester.js" -Value $content

Write-Host "✓ harvester.js patched"

# Apply same to dokki
$contentDokki = Get-Content "e:\Proj work\getclone\github-harvester\harvester-dokki.js" -Raw

$contentDokki = $contentDokki -replace `
'console\.log\(''  \[HUMAN\] pause'', delay2, ''ms''\);
    await sleep\(delay2\);

    // Wait for dropdown to appear after username triggers React re-render',
'console.log(''  [HUMAN] pause'', delay2, ''ms'');
    await sleep(delay2);

    // CRITICAL: WE validates service number server-side before enabling dropdown
    console.log(''  [WAIT] Waiting for WE server validation...'');
    await sleep(3000); // Server validation delay
    
    // Wait for dropdown to appear after username triggers React re-render'

$contentDokki = $contentDokki -replace `
'await sleep\(1000\);
    }

    console\.log\(''  \[OK\] Dropdown done\\n''\);',
'await sleep(1000);
    }

    console.log(''  [OK] Dropdown done'');
    
    // CRITICAL: Wait for React to update form state with dropdown selection
    console.log(''  [WAIT] Waiting for React form state update...'');
    await sleep(2000);
    console.log(''  [OK] Form state updated\n'');'

$contentDokki = $contentDokki -replace [regex]::Escape($oldSubmit), $newSubmit

Set-Content -Path "e:\Proj work\getclone\github-harvester\harvester-dokki.js" -Value $contentDokki

Write-Host "✓ harvester-dokki.js patched"
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host "✅ ULTIMATE FIX APPLIED"
Write-Host "═══════════════════════════════════════════════════════"
Write-Host ""
Write-Host "KEY FIXES:"
Write-Host "1. Added 3s wait after service number for WE server validation"
Write-Host "2. Added 2s wait after dropdown for React state update"
Write-Host "3. Replaced evaluate click with REAL mouse movement + click"
Write-Host "4. Added form validation trigger before submit"
Write-Host ""
Write-Host "WHY THIS WORKS:"
Write-Host "• Screenshots show dropdown appears AFTER service# validation"
Write-Host "• WE anti-bot detects missing mouse movement"
Write-Host "• React needs time to update form state after dropdown"
Write-Host "• Real mouse click bypasses automation detection"
Write-Host ""
Write-Host "PUSH AND TEST NOW!"
