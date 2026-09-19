const assert = require('node:assert/strict');
const test = require('node:test');

const Core = require('../ledger-core.js');

function ledger(records, accounts) {
    return Core.createLedger({
        accounts: accounts || [
            { id: 'Ss', label: 'Ss' },
            { id: 'CkPr', label: 'CkPr' },
            { id: 'CpRs', label: 'CpRs' }
        ],
        records
    });
}

test('replays cents exactly and allocates a market gain by largest remainder', () => {
    const document = ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 1, CkPr: 1, CpRs: 1 } },
        { serial: 1001, date: '2026-01-02', type: 'market', totalCents: 5 }
    ]);

    const result = Core.validateAndReplay(document);
    assert.deepEqual(result.latest.balancesCents, { Ss: 2, CkPr: 2, CpRs: 1 });
    assert.equal(result.latest.totalCents, 5);
    assert.equal(Object.values(result.latest.balancesCents).reduce((sum, value) => sum + value, 0), 5);
});

test('allocates a market loss deterministically without making a bucket negative', () => {
    const result = Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 1, CkPr: 1, CpRs: 1 } },
        { serial: 1001, date: '2026-01-02', type: 'market', totalCents: 2 }
    ]));

    assert.deepEqual(result.latest.balancesCents, { Ss: 0, CkPr: 1, CpRs: 1 });
});

test('sorts records by date and serial before replaying them', () => {
    const result = Core.validateAndReplay(ledger([
        { serial: 1002, date: '2026-01-02', type: 'market', totalCents: 12000 },
        { serial: 1001, date: '2026-01-01', type: 'market', totalCents: 11000 },
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 10000 } }
    ]));

    assert.deepEqual(result.records.map((record) => record.serial), [1000, 1001, 1002]);
    assert.equal(result.latest.totalCents, 12000);
});

test('supports adding a future bucket without changing previous balances', () => {
    const original = ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 10000 } },
        { serial: 1001, date: '2026-01-02', type: 'transfer', from: 'Ss', to: 'CkPr', amountCents: 2500 }
    ]);
    const withSanp = Core.addAccount(original, { id: 'SANp', label: 'Savings and Needs' });
    const result = Core.validateAndReplay(withSanp);

    assert.deepEqual(result.accountIds, ['Ss', 'CkPr', 'CpRs', 'SANp']);
    assert.equal(result.records[0].balancesCents.SANp, 0);
    assert.equal(result.latest.balancesCents.SANp, 0);

    const afterTransfer = Core.appendRecord(withSanp, {
        serial: 1002,
        date: '2026-01-03',
        type: 'transfer',
        from: 'CkPr',
        to: 'SANp',
        amountCents: 500
    });
    assert.equal(Core.validateAndReplay(afterTransfer).latest.balancesCents.SANp, 500);
});

test('deposits add new external funds to one bucket and update its share of the total', () => {
    const initial = ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 10000, CkPr: 20000 } }
    ]);
    const deposit = Core.makeDepositRecord({
        serial: 1001,
        date: '2026-01-02',
        account: 'CpRs',
        amountCents: 500000
    });
    assert.deepEqual(deposit, {
        serial: 1001,
        date: '2026-01-02',
        type: Core.EVENT_TYPES.DEPOSIT,
        account: 'CpRs',
        amountCents: 500000
    });

    const document = Core.appendRecord(initial, deposit);
    const result = Core.validateAndReplay(document);
    assert.equal(result.latest.totalCents, 530000);
    assert.equal(result.latest.balancesCents.CpRs, 500000);
    assert.equal(result.latest.depositCents, 500000);
    assert.equal(result.latest.ratios.CpRs, 500000 / 530000);
    assert.equal(result.lifetimeDepositedCents, 500000);

    // A v2 JSON export keeps deposits intact and can be safely re-imported.
    const exported = JSON.parse(Core.serializeLedger(document, { exportedAt: '2026-01-03T00:00:00.000Z' }));
    assert.deepEqual(exported.records[1], deposit);
    assert.equal(Core.validateAndReplay(exported).latest.totalCents, 530000);
});

test('rejects negative balances, invalid dates, duplicate initial records, and fractional cents', () => {
    assert.throws(() => Core.validateAndReplay(ledger([])), /exactly one initial/i);

    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-02-30', type: 'initial', amountsCents: { Ss: 100 } }
    ])), /real date/i);

    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 100.5 } }
    ])), /safe integer/i);

    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 100 } },
        { serial: 1001, date: '2026-01-02', type: 'transfer', from: 'Ss', to: 'CkPr', amountCents: 101 }
    ])), /exceeds the available/i);

    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 100 } },
        { serial: 1001, date: '2026-01-02', type: 'initial', amountsCents: { Ss: 100 } }
    ])), /second initial/i);

    assert.throws(() => Core.createLedger({ accounts: [{ id: 'constructor', label: 'Not safe' }] }), /reserved object-property/i);
    assert.throws(() => Core.createLedger({ accounts: [{ id: 'SafeId', label: '=Unsafe spreadsheet label' }] }), /spreadsheet formula/i);
    assert.throws(() => Core.createLedger({ accounts: [{ id: 'SafeId', label: "Unsafe\nlabel" }] }), /control characters/i);
    assert.throws(() => Core.createLedger({ accounts: [{ id: 'CashOne', label: 'Cash' }, { id: 'CashTwo', label: 'cash' }] }), /duplicate.*label/i);
    assert.throws(() => Core.makeDepositRecord({ serial: 1001, date: '2026-01-02', account: 'Ss', amountCents: 0 }), /at least 1 cents/i);
    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 100 } },
        { serial: 1001, date: '2026-01-02', type: 'deposit', account: 'NotABucket', amountCents: 1 }
    ])), /declared account/i);
});

test('withdrawals are account-specific, retain a positive total, and are tracked', () => {
    const result = Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 1000, CkPr: 2000 } },
        { serial: 1001, date: '2026-01-02', type: 'withdrawal', account: 'CkPr', amountCents: 750 }
    ]));
    assert.equal(result.latest.totalCents, 2250);
    assert.equal(result.latest.balancesCents.CkPr, 1250);
    assert.equal(result.lifetimeWithdrawnCents, 750);

    assert.throws(() => Core.validateAndReplay(ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 100 } },
        { serial: 1001, date: '2026-01-02', type: 'withdrawal', account: 'Ss', amountCents: 100 }
    ])), /zero or below/i);
});

test('migrates the legacy array format and ignores old floating-point display fields', () => {
    const legacy = [
        {
            serial: 1001,
            date: '2026-06-15',
            type: 'Initial Merge & Account Unification',
            ss: 0,
            ckpr: 25.11,
            cprs: 74.89,
            total: 100,
            ckprPercent: 0.2511
        },
        {
            serial: 1002,
            date: '2026-06-16',
            type: 'Market Valuation Update',
            total: 101.01,
            ckpr: 999999
        },
        {
            serial: 1003,
            date: '2026-06-17',
            type: 'Internal Transfer (Reallocation)',
            transferFrom: 'CpRs',
            transferTo: 'Ss',
            transferAmt: 1
        }
    ];
    const result = Core.validateAndReplay(legacy);

    assert.equal(result.document.schemaVersion, 2);
    assert.equal(result.document.metadata.migratedFrom, 'legacy-array-v1');
    assert.deepEqual(result.document.records[0].amountsCents, { Ss: 0, CkPr: 2511, CpRs: 7489 });
    assert.equal(result.latest.totalCents, 10101);
    assert.equal(result.latest.balancesCents.Ss, 100);
});

test('requires clean two-decimal UI money input and serializes v2 export metadata', () => {
    assert.equal(Core.parseMoneyToCents('123.45'), 12345);
    assert.equal(Core.parseMoneyToCents('-0.50'), -50);
    assert.equal(Core.centsToDecimalString(12345), '123.45');
    assert.throws(() => Core.parseMoneyToCents('1.005'), /two decimal/i);
    assert.throws(() => Core.parseMoneyToCents('$1.00'), /currency symbols/i);

    const document = ledger([
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 12345 } }
    ]);
    const exported = JSON.parse(Core.serializeLedger(document, { exportedAt: '2026-01-02T03:04:05.000Z' }));
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.metadata.currency, 'USD');
    assert.equal(exported.metadata.unit, 'cents');
    assert.equal(exported.metadata.exportedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(exported.records[0].amountsCents.Ss, 12345);
});

test('does not mutate a caller-owned document while replaying it', () => {
    const source = ledger([
        { serial: 1001, date: '2026-01-02', type: 'market', totalCents: 11000 },
        { serial: 1000, date: '2026-01-01', type: 'initial', amountsCents: { Ss: 10000 } }
    ]);
    const before = JSON.stringify(source);
    Core.validateAndReplay(source);
    assert.equal(JSON.stringify(source), before);
});
