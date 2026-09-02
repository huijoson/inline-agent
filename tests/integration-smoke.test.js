const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Integration & Single-File Userscript Verification (Issue #6)', () => {
  const userscriptPath = path.resolve(__dirname, '../inline-reservation-bot.user.js');
  const fileContent = fs.readFileSync(userscriptPath, 'utf8');
  const mirrorContent = fs.readFileSync(path.resolve(__dirname, '../inline-sniper.js'), 'utf8');

  it('preserves valid Tampermonkey userscript metadata header', () => {
    assert.ok(fileContent.includes('// ==UserScript=='), 'Must contain UserScript start tag');
    assert.ok(fileContent.includes('// @name         Inline 餐廳自動搶位助手'), 'Must preserve script name');
    assert.ok(fileContent.includes('// @match        https://inline.app/*'), 'Must match inline.app host');
    assert.ok(fileContent.includes('// @grant        none'), 'Must use grant none for native DOM context');
    assert.ok(fileContent.includes('// @run-at       document-idle'), 'Must run at document-idle');
    assert.ok(fileContent.includes('// ==/UserScript=='), 'Must contain UserScript end tag');
  });

  it('publishes updateable Tampermonkey metadata and identical distributed scripts', () => {
    const rawUserscriptUrl = 'https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js';

    assert.ok(fileContent.includes('// @version      2.2.1'));
    assert.ok(fileContent.includes(`// @updateURL    ${rawUserscriptUrl}`));
    assert.ok(fileContent.includes(`// @downloadURL  ${rawUserscriptUrl}`));
    assert.equal(fileContent, mirrorContent);
  });

  it('exports clean IIFE module interface without global namespace pollution in browser', () => {
    const {
      createInlineDomAdapter,
      InlineDomAdapter,
      createSnipingEngine,
      SnipingEngine,
      SnipingState,
    } = require('../inline-reservation-bot.user.js');

    assert.equal(typeof createInlineDomAdapter, 'function');
    assert.ok(InlineDomAdapter);
    assert.equal(typeof createSnipingEngine, 'function');
    assert.ok(SnipingEngine);
    assert.ok(SnipingState);
  });

  it('contains zero direct DOM or location.reload calls in SnipingEngine definition', () => {
    // Extract the body of createSnipingEngine
    const match = fileContent.match(/function createSnipingEngine\([\s\S]*?return \{[\s\S]*?\};[\s\S]*?\}/);
    assert.ok(match, 'createSnipingEngine function must exist in file');
    // Strip comments to only check executable code
    const executableCode = match[0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(!executableCode.includes('document.querySelector'), 'SnipingEngine must not call document.querySelector');
    assert.ok(!executableCode.includes('document.getElementById'), 'SnipingEngine must not call document.getElementById');
    assert.ok(!executableCode.includes('location.reload'), 'SnipingEngine must not call location.reload');
  });
});
