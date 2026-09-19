/*
 * Family Ledger core
 *
 * This module deliberately has no DOM, storage, or network dependencies.  It
 * is usable directly in a browser as window.FamilyLedgerCore and in Node via
 * require('./ledger-core.js').  Financial values are represented only as
 * integer USD cents in schema version 2.
 */
(function attachFamilyLedgerCore(root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.FamilyLedgerCore = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCore() {
    'use strict';

    const SCHEMA_VERSION = 2;
    const EVENT_TYPES = Object.freeze({
        INITIAL: 'initial',
        MARKET: 'market',
        TRANSFER: 'transfer',
        // A deposit is money newly added from outside the ledger. Unlike a
        // transfer, it increases both the selected bucket and the total.
        DEPOSIT: 'deposit',
        WITHDRAWAL: 'withdrawal'
    });

    const DEFAULT_ACCOUNTS = Object.freeze([
        Object.freeze({ id: 'Ss', label: 'Ss' }),
        Object.freeze({ id: 'CkPr', label: 'CkPr' }),
        Object.freeze({ id: 'CpRs', label: 'CpRs' })
    ]);

    const ROUNDING_RULE = 'All stored amounts are integer USD cents. Market gains and losses are allocated by the largest-remainder method using the active balances as weights; ties follow account order.';
    const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;
    const MAX_ACCOUNTS = 50;
    const MAX_RECORDS = 10000;
    const ACCOUNT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
    const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
    const UNSAFE_ACCOUNT_IDS = new Set(Object.getOwnPropertyNames(Object.prototype).map((name) => name.toLowerCase()));
    const METADATA_KEYS = new Set([
        'application',
        'applicationVersion',
        'currency',
        'unit',
        'rounding',
        'createdAt',
        'exportedAt',
        'migratedFrom'
    ]);

    class LedgerValidationError extends Error {
        constructor(message, path, code) {
            super(path ? `${path}: ${message}` : message);
            this.name = 'LedgerValidationError';
            this.path = path || '';
            this.code = code || 'VALIDATION_ERROR';
        }
    }

    function fail(path, message, code) {
        throw new LedgerValidationError(message, path, code);
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function cloneJson(value) {
        // Inputs originate from JSON files, but cloning this way also prevents
        // replay from ever mutating a caller-owned document.
        return JSON.parse(JSON.stringify(value));
    }

    function requirePlainObject(value, path) {
        if (!isPlainObject(value)) fail(path, 'must be an object.');
        return value;
    }

    function requireString(value, path, options) {
        if (typeof value !== 'string') fail(path, 'must be a string.');
        const result = options && options.trim === false ? value : value.trim();
        if (!result && (!options || options.allowEmpty !== true)) fail(path, 'must not be empty.');
        if (options && options.maxLength && result.length > options.maxLength) {
            fail(path, `must be at most ${options.maxLength} characters.`);
        }
        return result;
    }

    function requireSafeInteger(value, path, minimum) {
        if (!Number.isSafeInteger(value)) fail(path, 'must be a safe integer number of cents.');
        if (minimum !== undefined && value < minimum) fail(path, `must be at least ${minimum} cents.`);
        return value;
    }

    function ensureSafeCents(value, path) {
        if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SAFE_CENTS) {
            fail(path, 'is outside the supported integer-cent range.');
        }
        return value;
    }

    function safeAdd(left, right, path) {
        return ensureSafeCents(left + right, path);
    }

    function isValidIsoDate(value) {
        if (typeof value !== 'string') return false;
        const match = DATE_PATTERN.exec(value);
        if (!match) return false;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }

    function requireIsoDate(value, path) {
        if (!isValidIsoDate(value)) fail(path, 'must be a real date in YYYY-MM-DD format.');
        return value;
    }

    function isValidIsoTimestamp(value) {
        if (typeof value !== 'string' || value.length > 40) return false;
        // Date.parse accepts several ambiguous non-ISO forms, so require an
        // explicit UTC ISO timestamp before using it as export metadata.
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
        return !Number.isNaN(Date.parse(value));
    }

    function requireIsoTimestamp(value, path) {
        if (!isValidIsoTimestamp(value)) fail(path, 'must be a UTC ISO timestamp.');
        return value;
    }

    function normalizeAccount(account, path) {
        requirePlainObject(account, path);
        const id = requireString(account.id, `${path}.id`, { trim: false, maxLength: 32 });
        if (!ACCOUNT_ID_PATTERN.test(id)) {
            fail(`${path}.id`, 'must start with a letter and contain only letters, digits, hyphens, or underscores.');
        }
        if (UNSAFE_ACCOUNT_IDS.has(id.toLowerCase())) {
            fail(`${path}.id`, 'uses a reserved object-property name.');
        }
        const label = requireString(account.label === undefined ? id : account.label, `${path}.label`, { maxLength: 64 });
        if (/[\u0000-\u001F\u007F]/.test(label)) {
            fail(`${path}.label`, 'must not contain control characters.');
        }
        if (/^[=+\-@]/.test(label)) {
            fail(`${path}.label`, 'must not begin with a spreadsheet formula character.');
        }
        return { id, label };
    }

    function normalizeAccounts(accounts) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
            fail('accounts', 'must be a non-empty array of bucket accounts.');
        }
        if (accounts.length > MAX_ACCOUNTS) fail('accounts', `must contain no more than ${MAX_ACCOUNTS} accounts.`);
        const ids = new Set();
        const labels = new Set();
        const normalized = accounts.map((account, index) => {
            const result = normalizeAccount(account, `accounts[${index}]`);
            const comparisonId = result.id.toLowerCase();
            if (ids.has(comparisonId)) fail(`accounts[${index}].id`, 'duplicates an existing account id.');
            ids.add(comparisonId);
            // Labels are what people see in the table and transfer lists. Do
            // not accept visually confusing duplicate labels from an import.
            const comparisonLabel = result.label.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
            if (labels.has(comparisonLabel)) fail(`accounts[${index}].label`, 'duplicates an existing account label.');
            labels.add(comparisonLabel);
            return result;
        });
        return normalized;
    }

    function baseMetadata(overrides) {
        const metadata = {
            application: 'Family Ledger',
            currency: 'USD',
            unit: 'cents',
            rounding: ROUNDING_RULE
        };
        if (overrides !== undefined) {
            requirePlainObject(overrides, 'metadata');
            Object.keys(overrides).forEach((key) => {
                if (!METADATA_KEYS.has(key)) fail(`metadata.${key}`, 'is not a supported metadata field.');
                metadata[key] = overrides[key];
            });
        }
        return metadata;
    }

    function validateMetadata(metadata) {
        requirePlainObject(metadata, 'metadata');
        const result = cloneJson(metadata);

        Object.keys(result).forEach((key) => {
            if (!METADATA_KEYS.has(key)) fail(`metadata.${key}`, 'is not a supported metadata field.');
        });

        if (result.application !== undefined) requireString(result.application, 'metadata.application', { maxLength: 100 });
        if (result.applicationVersion !== undefined) requireString(result.applicationVersion, 'metadata.applicationVersion', { maxLength: 50 });
        if (result.currency !== 'USD') fail('metadata.currency', 'must be USD.');
        if (result.unit !== 'cents') fail('metadata.unit', 'must be cents.');
        if (result.rounding !== ROUNDING_RULE) fail('metadata.rounding', 'must contain the schema v2 rounding rule.');
        if (result.createdAt !== undefined) requireIsoTimestamp(result.createdAt, 'metadata.createdAt');
        if (result.exportedAt !== undefined) requireIsoTimestamp(result.exportedAt, 'metadata.exportedAt');
        if (result.migratedFrom !== undefined) requireString(result.migratedFrom, 'metadata.migratedFrom', { maxLength: 100 });
        return result;
    }

    function normalizeAmounts(amounts, accountIds, path) {
        requirePlainObject(amounts, path);
        const result = {};
        Object.keys(amounts).forEach((accountId) => {
            if (!accountIds.has(accountId)) fail(`${path}.${accountId}`, 'references an account that is not declared in accounts.');
            result[accountId] = requireSafeInteger(amounts[accountId], `${path}.${accountId}`, 0);
        });
        // Missing initial amounts intentionally mean zero. This lets a family
        // add a bucket later without rewriting old history.
        accountIds.forEach((accountId) => {
            if (!hasOwn(result, accountId)) result[accountId] = 0;
        });
        return result;
    }

    function normalizeRecord(record, index, accountIds) {
        const path = `records[${index}]`;
        requirePlainObject(record, path);
        const serial = requireSafeInteger(record.serial, `${path}.serial`, 1);
        const date = requireIsoDate(record.date, `${path}.date`);
        const type = requireString(record.type, `${path}.type`, { trim: false, maxLength: 32 });

        if (type === EVENT_TYPES.INITIAL) {
            if (!hasOwn(record, 'amountsCents')) fail(`${path}.amountsCents`, 'is required for an initial record.');
            return { serial, date, type, amountsCents: normalizeAmounts(record.amountsCents, accountIds, `${path}.amountsCents`) };
        }
        if (type === EVENT_TYPES.MARKET) {
            return { serial, date, type, totalCents: requireSafeInteger(record.totalCents, `${path}.totalCents`, 1) };
        }
        if (type === EVENT_TYPES.TRANSFER) {
            const from = requireString(record.from, `${path}.from`, { trim: false, maxLength: 32 });
            const to = requireString(record.to, `${path}.to`, { trim: false, maxLength: 32 });
            if (!accountIds.has(from)) fail(`${path}.from`, 'must reference a declared account.');
            if (!accountIds.has(to)) fail(`${path}.to`, 'must reference a declared account.');
            if (from === to) fail(path, 'cannot transfer to the same account.');
            return {
                serial,
                date,
                type,
                from,
                to,
                amountCents: requireSafeInteger(record.amountCents, `${path}.amountCents`, 1)
            };
        }
        if (type === EVENT_TYPES.DEPOSIT) {
            const account = requireString(record.account, `${path}.account`, { trim: false, maxLength: 32 });
            if (!accountIds.has(account)) fail(`${path}.account`, 'must reference a declared account.');
            return {
                serial,
                date,
                type,
                account,
                amountCents: requireSafeInteger(record.amountCents, `${path}.amountCents`, 1)
            };
        }
        if (type === EVENT_TYPES.WITHDRAWAL) {
            const account = requireString(record.account, `${path}.account`, { trim: false, maxLength: 32 });
            if (!accountIds.has(account)) fail(`${path}.account`, 'must reference a declared account.');
            return {
                serial,
                date,
                type,
                account,
                amountCents: requireSafeInteger(record.amountCents, `${path}.amountCents`, 1)
            };
        }
        fail(`${path}.type`, `must be one of: ${Object.keys(EVENT_TYPES).map((key) => EVENT_TYPES[key]).join(', ')}.`);
    }

    /**
     * Validates a v2 document's shape and returns a detached, canonical copy.
     * It deliberately does not replay balance-dependent operations; call
     * validateAndReplay() for safe import/commit behavior.
     */
    function validateLedgerDocument(document) {
        requirePlainObject(document, 'ledger');
        if (document.schemaVersion !== SCHEMA_VERSION) {
            fail('schemaVersion', `must be ${SCHEMA_VERSION}.`);
        }
        const accounts = normalizeAccounts(document.accounts);
        const accountIds = new Set(accounts.map((account) => account.id));
        if (!Array.isArray(document.records)) fail('records', 'must be an array.');
        if (document.records.length > MAX_RECORDS) fail('records', `must contain no more than ${MAX_RECORDS} records.`);
        const serials = new Set();
        const records = document.records.map((record, index) => {
            const normalized = normalizeRecord(record, index, accountIds);
            if (serials.has(normalized.serial)) fail(`records[${index}].serial`, 'must be unique.');
            serials.add(normalized.serial);
            return normalized;
        });
        return {
            schemaVersion: SCHEMA_VERSION,
            metadata: validateMetadata(document.metadata),
            accounts,
            records
        };
    }

    function sortRecords(records) {
        return records.slice().sort((left, right) => {
            if (left.date < right.date) return -1;
            if (left.date > right.date) return 1;
            return left.serial - right.serial;
        });
    }

    function sumBalances(balances, accountIds, path) {
        return accountIds.reduce((total, accountId) => safeAdd(total, balances[accountId], path), 0);
    }

    function cloneBalances(balances, accountIds) {
        const copy = {};
        accountIds.forEach((accountId) => { copy[accountId] = balances[accountId]; });
        return copy;
    }

    /**
     * Allocate a non-negative integer number of cents proportionally by
     * integer weights. Ties are intentionally resolved by account order so
     * the result is deterministic across browsers and exports.
     */
    function largestRemainderAllocate(amountCents, accountIds, weights) {
        requireSafeInteger(amountCents, 'allocation.amountCents', 0);
        if (!Array.isArray(accountIds) || accountIds.length === 0) fail('allocation.accounts', 'must include at least one account.');
        if (!isPlainObject(weights)) fail('allocation.weights', 'must be an object.');

        const totalWeight = accountIds.reduce((total, accountId) => {
            const weight = requireSafeInteger(weights[accountId], `allocation.weights.${accountId}`, 0);
            return safeAdd(total, weight, 'allocation.totalWeight');
        }, 0);
        if (totalWeight <= 0) fail('allocation.totalWeight', 'must be positive.');

        const amount = BigInt(amountCents);
        const divisor = BigInt(totalWeight);
        let allocated = 0;
        const shares = accountIds.map((accountId, index) => {
            const product = amount * BigInt(weights[accountId]);
            const base = Number(product / divisor);
            allocated = safeAdd(allocated, base, 'allocation.allocated');
            return { accountId, index, cents: base, remainder: product % divisor };
        });
        let remainderCents = amountCents - allocated;
        shares.sort((left, right) => {
            if (left.remainder === right.remainder) return left.index - right.index;
            return left.remainder > right.remainder ? -1 : 1;
        });
        for (let index = 0; index < remainderCents; index += 1) {
            shares[index].cents += 1;
        }
        const result = {};
        shares.forEach((share) => { result[share.accountId] = share.cents; });
        return result;
    }

    function allocateMarketDelta(deltaCents, accountIds, previousBalances, previousTotalCents) {
        ensureSafeCents(deltaCents, 'market.deltaCents');
        if (deltaCents === 0) return cloneBalances(previousBalances, accountIds);
        const allocation = largestRemainderAllocate(Math.abs(deltaCents), accountIds, previousBalances);
        const next = {};
        accountIds.forEach((accountId) => {
            const change = deltaCents > 0 ? allocation[accountId] : -allocation[accountId];
            next[accountId] = safeAdd(previousBalances[accountId], change, `market.balances.${accountId}`);
            if (next[accountId] < 0) fail(`market.balances.${accountId}`, 'would become negative.');
        });
        const calculatedTotal = sumBalances(next, accountIds, 'market.total');
        if (calculatedTotal !== previousTotalCents + deltaCents) {
            fail('market', 'allocation did not reconcile to the requested total.', 'INTERNAL_RECONCILIATION_ERROR');
        }
        return next;
    }

    function ratiosFor(balances, totalCents, accountIds) {
        const result = {};
        accountIds.forEach((accountId) => {
            result[accountId] = balances[accountId] / totalCents;
        });
        return result;
    }

    function enrichRecord(record, balances, totalCents, accountIds) {
        const enriched = Object.assign({}, record, {
            balancesCents: cloneBalances(balances, accountIds),
            totalCents,
            ratios: ratiosFor(balances, totalCents, accountIds)
        });
        if (record.type === EVENT_TYPES.DEPOSIT) enriched.depositCents = record.amountCents;
        if (record.type === EVENT_TYPES.WITHDRAWAL) enriched.withdrawalCents = record.amountCents;
        return enriched;
    }

    /**
     * Strictly validates and chronologically replays a v2 ledger.  Operations
     * are sorted by YYYY-MM-DD and then serial, so importing a file with rows
     * out of visual order remains deterministic rather than relying on array
     * order.  No input object is mutated.
     */
    function replayLedger(document) {
        const normalized = validateLedgerDocument(document);
        const accountIds = normalized.accounts.map((account) => account.id);
        const orderedRecords = sortRecords(normalized.records);
        const replayed = [];
        let balances = null;
        let totalCents = 0;
        let initialSeen = false;
        let lifetimeDepositedCents = 0;
        let lifetimeWithdrawnCents = 0;

        orderedRecords.forEach((record, index) => {
            const path = `records[${index}]`;
            if (record.type === EVENT_TYPES.INITIAL) {
                if (initialSeen) fail(path, 'contains a second initial record.');
                if (index !== 0) fail(path, 'the initial record must be the first chronological record.');
                initialSeen = true;
                balances = cloneBalances(record.amountsCents, accountIds);
                totalCents = sumBalances(balances, accountIds, `${path}.amountsCents`);
                if (totalCents <= 0) fail(path, 'initial balances must add up to more than zero.');
            } else {
                if (!initialSeen || balances === null) fail(path, 'requires an initial record first.');
                if (record.type === EVENT_TYPES.MARKET) {
                    const deltaCents = record.totalCents - totalCents;
                    balances = allocateMarketDelta(deltaCents, accountIds, balances, totalCents);
                    totalCents = record.totalCents;
                } else if (record.type === EVENT_TYPES.TRANSFER) {
                    if (balances[record.from] < record.amountCents) {
                        fail(`${path}.amountCents`, `exceeds the available balance in ${record.from}.`);
                    }
                    balances = cloneBalances(balances, accountIds);
                    balances[record.from] -= record.amountCents;
                    balances[record.to] = safeAdd(balances[record.to], record.amountCents, `${path}.to`);
                    // A transfer changes allocation but never the total.
                } else if (record.type === EVENT_TYPES.DEPOSIT) {
                    balances = cloneBalances(balances, accountIds);
                    balances[record.account] = safeAdd(balances[record.account], record.amountCents, `${path}.account`);
                    totalCents = safeAdd(totalCents, record.amountCents, `${path}.totalCents`);
                    lifetimeDepositedCents = safeAdd(lifetimeDepositedCents, record.amountCents, 'lifetimeDepositedCents');
                } else if (record.type === EVENT_TYPES.WITHDRAWAL) {
                    if (balances[record.account] < record.amountCents) {
                        fail(`${path}.amountCents`, `exceeds the available balance in ${record.account}.`);
                    }
                    const nextTotal = totalCents - record.amountCents;
                    if (nextTotal <= 0) fail(`${path}.amountCents`, 'would reduce the total balance to zero or below.');
                    balances = cloneBalances(balances, accountIds);
                    balances[record.account] -= record.amountCents;
                    totalCents = nextTotal;
                    lifetimeWithdrawnCents = safeAdd(lifetimeWithdrawnCents, record.amountCents, 'lifetimeWithdrawnCents');
                }
            }

            if (balances !== null) {
                const reconciledTotal = sumBalances(balances, accountIds, `${path}.balancesCents`);
                if (reconciledTotal !== totalCents) {
                    fail(path, 'does not reconcile to its account balances.', 'INTERNAL_RECONCILIATION_ERROR');
                }
                replayed.push(enrichRecord(record, balances, totalCents, accountIds));
            }
        });

        // An empty v2 envelope is useful only as an in-memory draft while the
        // new-ledger form is being completed. A persisted/imported ledger must
        // have one real baseline so it can be replayed and reconciled.
        if (!initialSeen) fail('records', 'must contain exactly one initial record.');

        const canonicalDocument = {
            schemaVersion: SCHEMA_VERSION,
            metadata: cloneJson(normalized.metadata),
            accounts: cloneJson(normalized.accounts),
            records: cloneJson(orderedRecords)
        };
        return {
            document: canonicalDocument,
            records: replayed,
            latest: replayed.length ? replayed[replayed.length - 1] : null,
            lifetimeDepositedCents,
            lifetimeWithdrawnCents,
            accountIds: accountIds.slice()
        };
    }

    function normalizeLegacyType(value, path) {
        if (typeof value !== 'string') fail(path, 'must be a legacy event type string.');
        const type = value.trim().toLowerCase();
        if (type === 'initial' || type === 'initial merge & account unification' || type === 'initial merge') return EVENT_TYPES.INITIAL;
        if (type === 'market' || type === 'market valuation update') return EVENT_TYPES.MARKET;
        if (type === 'transfer' || type === 'internal transfer (reallocation)' || type === 'internal transfer') return EVENT_TYPES.TRANSFER;
        if (type === 'deposit' || type === 'new funds' || type === 'new fund deposit' || type === 'new funds deposit') return EVENT_TYPES.DEPOSIT;
        if (type === 'withdrawal' || type === 'cprs partial withdrawal event' || type === 'partial withdrawal') return EVENT_TYPES.WITHDRAWAL;
        fail(path, `does not map to a supported legacy event type (${value}).`);
    }

    function normalizeLegacyAccount(value, path) {
        const raw = requireString(value, path, { maxLength: 32 });
        const lower = raw.toLowerCase();
        if (lower === 'ss') return 'Ss';
        if (lower === 'ckpr') return 'CkPr';
        if (lower === 'cprs') return 'CpRs';
        if (!ACCOUNT_ID_PATTERN.test(raw)) fail(path, 'is not a valid account id.');
        return raw;
    }

    function decimalStringForLegacy(value, path) {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail(path, 'must be a finite dollar amount.');
            return String(value);
        }
        if (typeof value === 'string') return value.trim();
        fail(path, 'must be a dollar amount.');
    }

    /**
     * Legacy files stored floating-point dollar values.  During one-time
     * migration they are rounded to the nearest cent, with a half-cent rounded
     * away from zero.  Schema v2 never repeats this conversion.
     */
    function legacyDollarsToCents(value, path) {
        const raw = decimalStringForLegacy(value, path);
        const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
        if (!match) fail(path, 'must be a plain decimal dollar amount.');
        const negative = match[1] === '-';
        const whole = BigInt(match[2]);
        const fraction = match[3] || '';
        const centsText = (fraction.slice(0, 2) + '00').slice(0, 2);
        let cents = whole * 100n + BigInt(centsText);
        if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
        if (cents > BigInt(MAX_SAFE_CENTS)) fail(path, 'is outside the supported integer-cent range.');
        const result = Number(cents) * (negative ? -1 : 1);
        return result === 0 ? 0 : result;
    }

    function getLegacyValue(record, keys, path, defaultValue) {
        for (let index = 0; index < keys.length; index += 1) {
            if (hasOwn(record, keys[index])) return record[keys[index]];
        }
        if (defaultValue !== undefined) return defaultValue;
        fail(path, 'is required.');
    }

    function legacySerial(value, path) {
        if (Number.isSafeInteger(value) && value >= 1) return value;
        if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1) return Number(value);
        fail(path, 'must be a positive integer serial number.');
    }

    /**
     * Converts the original array-only format into schema v2.  It ignores old
     * derived balances and percentages and recreates them during replay.
     */
    function migrateLegacyArray(legacyRecords) {
        if (!Array.isArray(legacyRecords)) fail('legacy', 'must be an array.');
        if (legacyRecords.length > MAX_RECORDS) fail('legacy', `must contain no more than ${MAX_RECORDS} records.`);
        const accountOrder = DEFAULT_ACCOUNTS.map((account) => account.id);
        const accountsById = new Map(DEFAULT_ACCOUNTS.map((account) => [account.id, { id: account.id, label: account.label }]));

        function ensureAccount(accountId) {
            if (!accountsById.has(accountId)) {
                accountsById.set(accountId, { id: accountId, label: accountId });
                accountOrder.push(accountId);
            }
        }

        const records = legacyRecords.map((legacyRecord, index) => {
            const path = `legacy[${index}]`;
            requirePlainObject(legacyRecord, path);
            const serial = legacySerial(legacyRecord.serial, `${path}.serial`);
            const date = requireIsoDate(legacyRecord.date, `${path}.date`);
            const type = normalizeLegacyType(legacyRecord.type, `${path}.type`);

            if (type === EVENT_TYPES.INITIAL) {
                return {
                    serial,
                    date,
                    type,
                    amountsCents: {
                        Ss: legacyDollarsToCents(getLegacyValue(legacyRecord, ['ss', 'Ss'], `${path}.ss`, 0), `${path}.ss`),
                        CkPr: legacyDollarsToCents(getLegacyValue(legacyRecord, ['ckpr', 'CkPr'], `${path}.ckpr`, 0), `${path}.ckpr`),
                        CpRs: legacyDollarsToCents(getLegacyValue(legacyRecord, ['cprs', 'CpRs'], `${path}.cprs`, 0), `${path}.cprs`)
                    }
                };
            }
            if (type === EVENT_TYPES.MARKET) {
                return {
                    serial,
                    date,
                    type,
                    totalCents: legacyDollarsToCents(getLegacyValue(legacyRecord, ['total'], `${path}.total`), `${path}.total`)
                };
            }
            if (type === EVENT_TYPES.TRANSFER) {
                const from = normalizeLegacyAccount(getLegacyValue(legacyRecord, ['transferFrom', 'from'], `${path}.transferFrom`), `${path}.transferFrom`);
                const to = normalizeLegacyAccount(getLegacyValue(legacyRecord, ['transferTo', 'to'], `${path}.transferTo`), `${path}.transferTo`);
                ensureAccount(from);
                ensureAccount(to);
                return {
                    serial,
                    date,
                    type,
                    from,
                    to,
                    amountCents: legacyDollarsToCents(getLegacyValue(legacyRecord, ['transferAmt', 'amount'], `${path}.transferAmt`), `${path}.transferAmt`)
                };
            }
            if (type === EVENT_TYPES.DEPOSIT) {
                const account = normalizeLegacyAccount(getLegacyValue(legacyRecord, ['depositAccount', 'account'], `${path}.account`), `${path}.account`);
                ensureAccount(account);
                return {
                    serial,
                    date,
                    type,
                    account,
                    amountCents: legacyDollarsToCents(getLegacyValue(legacyRecord, ['depositAmt', 'amount'], `${path}.depositAmt`), `${path}.depositAmt`)
                };
            }
            const account = normalizeLegacyAccount(getLegacyValue(legacyRecord, ['withdrawAccount', 'account'], `${path}.account`, 'CpRs'), `${path}.account`);
            ensureAccount(account);
            return {
                serial,
                date,
                type,
                account,
                amountCents: legacyDollarsToCents(getLegacyValue(legacyRecord, ['withdrawAmt', 'amount'], `${path}.withdrawAmt`), `${path}.withdrawAmt`)
            };
        });

        return {
            schemaVersion: SCHEMA_VERSION,
            metadata: baseMetadata({ migratedFrom: 'legacy-array-v1' }),
            accounts: accountOrder.map((accountId) => accountsById.get(accountId)),
            records
        };
    }

    function validateAndReplay(input) {
        if (Array.isArray(input)) return replayLedger(migrateLegacyArray(input));
        return replayLedger(input);
    }

    function createLedger(options) {
        const source = options || {};
        if (!isPlainObject(source)) fail('options', 'must be an object.');
        const document = {
            schemaVersion: SCHEMA_VERSION,
            metadata: baseMetadata(source.metadata),
            accounts: source.accounts === undefined ? cloneJson(DEFAULT_ACCOUNTS) : source.accounts,
            records: source.records === undefined ? [] : source.records
        };
        return validateLedgerDocument(document);
    }

    function nextSerial(records) {
        if (!Array.isArray(records) || records.length === 0) return 1000;
        let highest = 999;
        records.forEach((record, index) => {
            if (!isPlainObject(record)) fail(`records[${index}]`, 'must be an object.');
            const serial = requireSafeInteger(record.serial, `records[${index}].serial`, 1);
            if (serial > highest) highest = serial;
        });
        if (highest >= MAX_SAFE_CENTS) fail('records', 'cannot generate another safe serial number.');
        return highest + 1;
    }

    function makeInitialRecord(options) {
        requirePlainObject(options, 'initial');
        return {
            serial: requireSafeInteger(options.serial, 'initial.serial', 1),
            date: requireIsoDate(options.date, 'initial.date'),
            type: EVENT_TYPES.INITIAL,
            amountsCents: cloneJson(requirePlainObject(options.amountsCents, 'initial.amountsCents'))
        };
    }

    function makeMarketRecord(options) {
        requirePlainObject(options, 'market');
        return {
            serial: requireSafeInteger(options.serial, 'market.serial', 1),
            date: requireIsoDate(options.date, 'market.date'),
            type: EVENT_TYPES.MARKET,
            totalCents: requireSafeInteger(options.totalCents, 'market.totalCents', 1)
        };
    }

    function makeTransferRecord(options) {
        requirePlainObject(options, 'transfer');
        return {
            serial: requireSafeInteger(options.serial, 'transfer.serial', 1),
            date: requireIsoDate(options.date, 'transfer.date'),
            type: EVENT_TYPES.TRANSFER,
            from: requireString(options.from, 'transfer.from', { trim: false, maxLength: 32 }),
            to: requireString(options.to, 'transfer.to', { trim: false, maxLength: 32 }),
            amountCents: requireSafeInteger(options.amountCents, 'transfer.amountCents', 1)
        };
    }

    function makeWithdrawalRecord(options) {
        requirePlainObject(options, 'withdrawal');
        return {
            serial: requireSafeInteger(options.serial, 'withdrawal.serial', 1),
            date: requireIsoDate(options.date, 'withdrawal.date'),
            type: EVENT_TYPES.WITHDRAWAL,
            account: requireString(options.account, 'withdrawal.account', { trim: false, maxLength: 32 }),
            amountCents: requireSafeInteger(options.amountCents, 'withdrawal.amountCents', 1)
        };
    }

    function makeDepositRecord(options) {
        requirePlainObject(options, 'deposit');
        return {
            serial: requireSafeInteger(options.serial, 'deposit.serial', 1),
            date: requireIsoDate(options.date, 'deposit.date'),
            type: EVENT_TYPES.DEPOSIT,
            account: requireString(options.account, 'deposit.account', { trim: false, maxLength: 32 }),
            amountCents: requireSafeInteger(options.amountCents, 'deposit.amountCents', 1)
        };
    }

    function appendRecord(document, record) {
        const canonical = validateLedgerDocument(document);
        const candidate = {
            schemaVersion: SCHEMA_VERSION,
            metadata: canonical.metadata,
            accounts: canonical.accounts,
            records: canonical.records.concat([record])
        };
        return validateAndReplay(candidate).document;
    }

    /** Adds a zero-balance bucket. It has no financial effect on old records. */
    function addAccount(document, account) {
        const canonical = validateLedgerDocument(document);
        const normalizedAccount = normalizeAccount(account, 'account');
        if (canonical.accounts.some((existing) => existing.id.toLowerCase() === normalizedAccount.id.toLowerCase())) {
            fail('account.id', 'duplicates an existing account id.');
        }
        const candidate = {
            schemaVersion: SCHEMA_VERSION,
            metadata: canonical.metadata,
            accounts: canonical.accounts.concat([normalizedAccount]),
            records: canonical.records
        };
        return validateAndReplay(candidate).document;
    }

    /**
     * Strict, user-input friendly conversion. Unlike legacy migration, values
     * with more than two fractional digits are rejected rather than rounded.
     */
    function parseMoneyToCents(value) {
        let raw;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail('money', 'must be a finite amount.');
            raw = String(value);
        } else if (typeof value === 'string') {
            raw = value.trim();
        } else {
            fail('money', 'must be a number or decimal string.');
        }
        const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
        if (!match) fail('money', 'must use at most two decimal places and no currency symbols or separators.');
        const whole = BigInt(match[2]);
        const fraction = (match[3] || '').padEnd(2, '0');
        let cents = whole * 100n + BigInt(fraction);
        if (cents > BigInt(MAX_SAFE_CENTS)) fail('money', 'is outside the supported integer-cent range.');
        if (match[1] === '-') cents = -cents;
        const result = Number(cents);
        return result === 0 ? 0 : result;
    }

    function centsToDecimalString(cents) {
        requireSafeInteger(cents, 'cents');
        const negative = cents < 0;
        const absolute = Math.abs(cents);
        const whole = Math.floor(absolute / 100);
        const fraction = String(absolute % 100).padStart(2, '0');
        return `${negative ? '-' : ''}${whole}.${fraction}`;
    }

    /**
     * Produces a stable, validated v2 JSON export. The records are sorted in
     * replay order and metadata identifies the date of this export.
     */
    function serializeLedger(document, metadataOverrides) {
        const replay = validateAndReplay(document);
        let overrides = {};
        if (metadataOverrides !== undefined) {
            requirePlainObject(metadataOverrides, 'metadataOverrides');
            Object.keys(metadataOverrides).forEach((key) => {
                if (!METADATA_KEYS.has(key)) fail(`metadataOverrides.${key}`, 'is not a supported metadata field.');
                overrides[key] = metadataOverrides[key];
            });
        }
        const exportMetadata = {};
        Object.keys(replay.document.metadata).forEach((key) => { exportMetadata[key] = replay.document.metadata[key]; });
        Object.keys(overrides).forEach((key) => { exportMetadata[key] = overrides[key]; });
        exportMetadata.exportedAt = overrides.exportedAt === undefined ? new Date().toISOString() : overrides.exportedAt;
        const metadata = baseMetadata(exportMetadata);
        const output = {
            schemaVersion: SCHEMA_VERSION,
            metadata: validateMetadata(metadata),
            accounts: replay.document.accounts,
            records: replay.document.records
        };
        return JSON.stringify(output, null, 2);
    }

    return Object.freeze({
        SCHEMA_VERSION,
        EVENT_TYPES,
        DEFAULT_ACCOUNTS,
        ROUNDING_RULE,
        MAX_ACCOUNTS,
        MAX_RECORDS,
        LedgerValidationError,
        createLedger,
        validateLedgerDocument,
        validateAndReplay,
        replayLedger,
        migrateLegacyArray,
        serializeLedger,
        addAccount,
        appendRecord,
        nextSerial,
        makeInitialRecord,
        makeMarketRecord,
        makeTransferRecord,
        makeDepositRecord,
        makeWithdrawalRecord,
        parseMoneyToCents,
        centsToDecimalString,
        largestRemainderAllocate,
        isValidIsoDate
    });
}));
