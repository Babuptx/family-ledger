const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'Start-Family-Ledger.cmd'), 'utf8');
const launcherScript = fs.readFileSync(path.join(root, 'Start-Family-Ledger.ps1'), 'utf8');

test('the static shell uses local assets and a restrictive CSP', () => {
    assert.match(index, /href="\.\/styles\.css"/);
    assert.match(index, /src="\.\/ledger-core\.js"/);
    assert.match(index, /src="\.\/app\.js"/);
    assert.match(index, /id="initialLoadJsonButton"/);
    assert.match(index, /id="depositForm"/);
    assert.match(index, /id="liveLedgerTitle"/);
    assert.match(index, /id="refreshRateButton"/);
    assert.match(index, /Content-Security-Policy/);
    assert.doesNotMatch(index, /unsafe-inline/);
    assert.match(index, /connect-src 'self' https:\/\/open\.er-api\.com/);
    assert.match(styles, /\.download-link/);
});

test('the UI does not use unsafe record HTML interpolation or inline event handlers', () => {
    assert.doesNotMatch(app, /innerHTML/);
    assert.doesNotMatch(app, /outerHTML/);
    assert.doesNotMatch(index, /\son[a-z]+\s*=/i);
    assert.match(app, /textContent/);
    assert.match(app, /addEventListener/);
    assert.match(app, /initialLoadJsonButton\.addEventListener/);
    assert.match(app, /function selectOptionsForDocument\(select, ledgerDocument, selectedId\)/);
    assert.match(app, /ledgerDocument\.accounts\.forEach/);
    assert.match(app, /function trapModalFocus\(event\)/);
    assert.match(app, /pendingMarketDocument = null/);
    assert.match(app, /Core\.makeDepositRecord/);
    assert.match(app, /ACCOUNT_COLUMN_ICONS/);
    assert.match(app, /window\.open\(window\.location\.href, '_blank'\)/);
    assert.match(app, /setInterval\(updateLiveLedgerTitle, 1_000\)/);
});

test('the USD/INR rate refreshes automatically and ExcelJS is integrity pinned', () => {
    assert.match(app, /void refreshExchangeRate\(\{ automatic: true \}\)/);
    assert.match(app, /function refreshExchangeRate\(options\)/);
    assert.match(app, /refreshRateButton\.addEventListener/);
    assert.doesNotMatch(app, /window\.confirm\('Load a live USD\/INR rate/);
    assert.match(app, /window\.confirm\('Excel export loads a pinned third-party Excel library/);
    assert.match(app, /EXCELJS_SRI/);
    assert.match(app, /script\.integrity = EXCELJS_SRI/);
    assert.match(app, /script\.referrerPolicy = 'no-referrer'/);
    assert.match(app, /referrerPolicy: 'no-referrer'/);
    assert.match(app, /let excelJsLoadPromise = null/);
    assert.match(app, /excelJsLoadPromise = null/);
    assert.match(app, /script\.remove\(\)/);
});

test('the requested visual labels and author credit are present', () => {
    assert.match(index, /📂 Load JSON \(Drive\)/);
    assert.match(index, /💾 Save JSON As\.\.\. \(Drive\)/);
    assert.match(index, /📊 Export Beautiful Excel \(\.xlsx\)/);
    assert.match(app, /Ss: '👩'/);
    assert.match(app, /CkPr: '👦👧'/);
    assert.match(app, /CpRs: '👨👩'/);
    assert.match(index, /babuptx@gmail\.com/);
});

test('the Windows launcher serves the current folder only on loopback', () => {
    assert.match(launcher, /Start-Family-Ledger\.ps1/);
    assert.match(launcherScript, /http\.server/);
    assert.match(launcherScript, /127\.0\.0\.1/);
    assert.match(launcherScript, /http:\/\/localhost:\$Port\//);
});
