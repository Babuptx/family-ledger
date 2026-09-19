# Family Ledger

Family Ledger is a small, local-first browser app for a family to follow one combined balance across named bucket accounts such as `Ss`, `CkPr`, `CpRs`, and a future `SANp` bucket. It is deliberately data-agnostic: it starts with no ledger data, has no sign-in or database, and lets each family keep its own timestamped JSON backups in a folder it controls.

This is a family organizer, not a bank, tax tool, investment platform, or audit-grade accounting system. Review important figures independently before making financial decisions.

## What stays local

- The ledger engine, calculations, validation, import, export, and help screen run in the browser.
- The app has no application backend, account system, database, or Google Drive/OneDrive connection.
- A JSON backup is read only after you choose it in the browser’s file picker. A backup is written only when you choose Save JSON.
- The app does not automatically upload ledger entries or JSON files. A cloud-sync client such as Google Drive for desktop or OneDrive may sync a file that *you* save in its folder; that is separate from this app.
- The visual theme preference may be stored in the browser’s `localStorage`. Ledger records are not stored there as a replacement for a JSON backup.

Keep backups private. JSON is readable plaintext financial information, so use a protected personal folder and do not email, share, or commit a backup unless you mean to disclose it.

## Run it

1. Clone or download the complete repository folder.
2. Keep `index.html`, `styles.css`, `app.js`, and `ledger-core.js` together.
3. Open `index.html` in a current desktop browser. If your browser’s local-file policy prevents it, serve the same folder with any local static-file server.

There is no install, account, database setup, or web server required for normal use. Node.js is only used for automated tests.

### One-click Windows launcher

On Windows, double-click [`Start-Family-Ledger.cmd`](Start-Family-Ledger.cmd). It starts a loopback-only Python server for this folder and opens `http://localhost:8000` in your default browser. Leave its PowerShell window open while using the app; close it to stop the server. The launcher needs Python (the normal Windows `py` launcher or `python` command). If port 8000 is occupied, run `Start-Family-Ledger.ps1 -Port 8001` in PowerShell instead.

## Everyday SOP

1. For a new ledger, enter the baseline date and starting amounts for the initial buckets, then choose **Start ledger**.
2. For an existing ledger, choose **Load JSON backup** and select the most recent trusted file. If current edits have not been saved, the app asks before replacing them.
3. Record a **market valuation** when the combined account value changes. Enter the new total, rather than manually changing each bucket.
4. Use **Add new funds** to record fresh money arriving in a chosen bucket. It increases the combined total and that bucket's balance; later market valuations use the resulting, updated bucket shares for their proportional allocation.
5. Use a **transfer** to move money between two buckets. A transfer does not change the total and cannot exceed the source balance.
6. Use the balance-review prompt to record a **withdrawal** from the selected bucket when appropriate. A withdrawal cannot exceed that bucket or reduce the combined balance to zero.
7. To add an account such as `SANp`, choose **Add another bucket**. It begins at zero, creates no money, and can be funded later with a transfer or new funds.
8. Choose **Save JSON backup** after meaningful changes. Keep several timestamped versions in a folder you control. JSON is the canonical backup; the Excel export is a convenient report.
9. Choose **Start another new ledger** to open a separate fresh-ledger browser tab or window. The current ledger remains open and unchanged; saved JSON backups are never deleted.

The floating **?** button in the lower-right corner repeats this SOP inside the app.

The panda title in the left panel updates each second using the browser/device's local time zone. It intentionally does not make an IP-location lookup, so that live display does not disclose your location to another service.

## Money and calculation rules

All canonical amounts are whole integer USD cents. The app accepts a maximum of two decimal places for new entries and never persists floating-point dollar amounts.

For a market valuation, the change from the previous total is allocated across active buckets in proportion to their prior balances. Cents are allocated with the deterministic largest-remainder method; ties follow the declared bucket order. Consequently, bucket balances always add exactly to the reported total, even when a change cannot divide evenly.

Individual buckets may be zero. The initial and post-withdrawal total must be positive, and no bucket may become negative.

New-funds entries increase both the selected bucket and the combined balance by the same positive number of cents. They are intentionally not treated as a market gain: the money is assigned entirely to the bucket selected when it arrives. That makes the next market valuation reflect the new share composition.

## JSON backups and schema v2

Current exports are a versioned JSON object rather than the earlier bare array. A simplified v2 file looks like this:

```json
{
  "schemaVersion": 2,
  "metadata": {
    "application": "Family Ledger",
    "currency": "USD",
    "unit": "cents",
    "rounding": "All stored amounts are integer USD cents...",
    "exportedAt": "2026-09-19T18:00:00.000Z"
  },
  "accounts": [
    { "id": "Ss", "label": "Ss" },
    { "id": "CkPr", "label": "CkPr" },
    { "id": "CpRs", "label": "CpRs" }
  ],
  "records": [
    {
      "serial": 1000,
      "date": "2026-09-19",
      "type": "initial",
      "amountsCents": { "Ss": 0, "CkPr": 3100000, "CpRs": 39200000 }
    },
    {
      "serial": 1001,
      "date": "2026-09-20",
      "type": "market",
      "totalCents": 43150000
    }
  ]
}
```

The `metadata` block records the base currency, unit, rounding rule, and UTC export time. The `accounts` registry is how the app supports additional buckets. Each account has a stable ID and a display label. Canonical records contain event inputs only:

| Event type | Required money data |
| --- | --- |
| `initial` | `amountsCents` by account ID |
| `market` | `totalCents` |
| `deposit` | `account` and `amountCents` |
| `transfer` | `from`, `to`, and `amountCents` |
| `withdrawal` | `account` and `amountCents` |

Calculated bucket balances, totals, and split ratios are replayed from those inputs; they are not trusted from an imported file. Records are replayed by date and then serial number. A valid ledger has one initial record, and it must be chronologically first.

### Loading an older backup

Older Family Ledger backups are a bare JSON array with decimal-dollar fields such as `ckpr`, `cprs`, `ss`, `total`, and percentage values. The app recognizes that legacy format, converts it in memory to schema v2, and recalculates all derived balances and ratios.

During that one-time migration, old decimal amounts are converted to cents by rounding a half-cent away from zero. The legacy app used floating-point calculations, so an old displayed derived balance can differ by a few cents after replay. The original event inputs, not those derived display fields, are authoritative for migration. After confirming the imported ledger looks right, immediately save a new timestamped v2 JSON backup.

Unknown future schema versions and malformed, incomplete, unsafe, or financially impossible files are rejected without replacing the open ledger.

## Privacy, offline use, and network features

The core ledger works offline in USD, and remains usable if its exchange-rate request is unavailable. No financial data is intentionally included in any network request.

The app automatically attempts to fetch the USD/INR rate from `https://open.er-api.com/v6/latest/USD` when the page loads, so the displayed `$1 = ₹xx.xx` value is current when available. Its request uses a no-referrer policy. A **Refresh rate** button lets you fetch the rate again whenever you choose. If you need fully offline use, simply continue in USD; the ledger does not require a rate to calculate or save data.

Excel export remains an optional convenience feature: clicking **Export Excel** lazy-loads ExcelJS 4.4.0 from `https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js`. The script is integrity-pinned with `sha512-dlPw+ytv/6JyepmelABrgeYgHI0O+frEwgfnPdXDTOIZz+eDgfW07QXG02/O8COfivBdGNINy+Vex+lYmJ5rxw==`; if that content does not match, the browser blocks it rather than executing an altered library.

Those providers can still receive ordinary connection metadata such as your IP address, browser details, and request time. They do not receive ledger values from this app. The app labels these choices in its help screen, and the applicable browser security policy limits where they can connect. If you need strict offline operation, remain in USD and use JSON export only.

## Backup practice and Git safety

The repository’s [`.gitignore`](.gitignore) excludes the app’s standard backup names:

- `Family_Ledger_as_on_*.json`
- `Family_Ledger_as_on_*.xlsx`

That helps prevent an accidental `git add .`, but it is not encryption, access control, or a substitute for checking `git status`. Keep private exports out of public repositories. The included example backup in a working folder is ignored as soon as `.gitignore` is present; it is not made safe retroactively if it was already committed somewhere else.

## Validation and safety behavior

Before the app commits an add, edit, deletion, or import, it validates a temporary copy and replays the complete ledger. It checks, among other things:

- real ISO dates and chronological baseline placement;
- unique positive serial numbers;
- known event types and declared bucket IDs;
- integer-cent, positive market, new-funds, transfer, and withdrawal amounts;
- no overdraft or zero/negative combined balance; and
- reconciliation of every bucket total.

Imported records are rendered through DOM text APIs rather than interpolated HTML. That is why an arbitrary value in a JSON backup is displayed as text instead of being treated as page markup or code. Still, only load backups you trust: JSON remains editable data, not a cryptographically signed audit trail.

## Development and tests

The application has no runtime npm dependency. The standalone [`ledger-core.js`](ledger-core.js) module is shared by the browser page and the test suite.

To run checks, install Node.js 20 or later and execute:

```sh
npm ci
npm test
```

[`tests/ledger-core.test.cjs`](tests/ledger-core.test.cjs) covers integer-cent parsing, validation, replay, new-funds entries, transfers, withdrawals, bucket additions, deterministic allocation, export, and legacy migration. The checked-in [CI workflow](.github/workflows/ci.yml) runs the same test command on Node 20 and Node 22 for changes to `main` and `sandbox` and for pull requests targeting `main`.

When changing ledger rules, update the tests first or alongside the change. Never put a personal JSON backup, credentials, or access tokens in a commit.

## License

Family Ledger was authored and is owned by **Babuptx**. Contact: [babuptx@gmail.com](mailto:babuptx@gmail.com).

The source is available under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits personal and other noncommercial use, modification, and distribution under its terms; commercial use is not granted. It is a source-available license, not an OSI-approved open-source license.
