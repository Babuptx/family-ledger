/*
 * Family Ledger browser UI
 *
 * This file deliberately keeps browser concerns (DOM, files, optional network
 * helpers) separate from ledger-core.js. Ledger values never leave this page
 * through the normal JSON workflow.
 */
(function familyLedgerApplication() {
    'use strict';

    const Core = window.FamilyLedgerCore;
    const APP_VERSION = '3.1.0';
    const MAX_LIMIT_CENTS = 50_000_000;
    const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
    const MAX_IMPORT_RECORDS = 5_000;
    const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
    const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    const EXCELJS_SRI = 'sha512-dlPw+ytv/6JyepmelABrgeYgHI0O+frEwgfnPdXDTOIZz+eDgfW07QXG02/O8COfivBdGNINy+Vex+lYmJ5rxw==';
    const ACCOUNT_COLUMN_ICONS = Object.freeze({
        Ss: '👩',
        CkPr: '👦👧',
        CpRs: '👨👩'
    });

    let ledger = null;
    let replay = null;
    let hasUnsavedChanges = false;
    let displayCurrency = 'USD';
    let exchangeRateInr = null;
    let exchangeRateFetchedAt = null;
    let pendingMarketDocument = null;
    let editingSerial = null;
    let lastFocusedElement = null;
    let initialAccountCounter = 0;
    let excelJsLoadPromise = null;
    let fxRequestPromise = null;

    const elements = {};
    const byId = (id) => document.getElementById(id);

    function localIsoDate(date) {
        const value = date || new Date();
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function timestampForFilename() {
        return new Date().toISOString().replace(/[-:T.]/g, '_').replace(/_Z$/, 'Z');
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function makeElement(tagName, text, className) {
        const node = document.createElement(tagName);
        if (text !== undefined && text !== null) node.textContent = String(text);
        if (className) node.className = className;
        return node;
    }

    function setNotice(message, kind) {
        elements.statusNotice.textContent = message;
        elements.statusNotice.className = `notice${kind ? ` ${kind}` : ''}`;
    }

    function errorText(error) {
        if (error && typeof error.message === 'string') return error.message;
        return 'An unexpected error occurred.';
    }

    function reportError(prefix, error) {
        setNotice(`${prefix}: ${errorText(error)}`, 'error');
    }

    function assertCoreIsAvailable() {
        if (!Core) throw new Error('The local ledger engine did not load. Keep index.html, ledger-core.js, and app.js together in the same folder.');
    }

    function isValidBucketLabel(value) {
        return typeof value === 'string'
            && value.trim().length > 0
            && value.trim().length <= 64
            && !/[\u0000-\u001F\u007F]/.test(value)
            && !/^[=+\-@]/.test(value.trim());
    }

    function normalizedBucketLabel(value) {
        if (!isValidBucketLabel(value)) {
            throw new Error('Bucket names must be 1–64 readable characters, must not contain control characters, and cannot start with =, +, -, or @.');
        }
        return value.trim().replace(/\s+/g, ' ');
    }

    function uniqueAccountId(label, accounts) {
        const taken = new Set((accounts || []).map((account) => account.id.toLowerCase()));
        let base = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/[-_]+$/g, '').replace(/^[-_]+/g, '');
        if (!base) base = 'Bucket';
        if (!/^[A-Za-z]/.test(base)) base = `Bucket-${base}`;
        base = base.slice(0, 28);
        let candidate = base;
        let suffix = 2;
        while (taken.has(candidate.toLowerCase())) {
            const suffixText = `-${suffix}`;
            candidate = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
            suffix += 1;
        }
        return candidate;
    }

    function accountById(accountId) {
        return ledger && ledger.accounts.find((account) => account.id === accountId);
    }

    function accountLabel(accountId) {
        const account = accountById(accountId);
        return account ? account.label : accountId;
    }

    function accountColumnLabel(account) {
        const icon = ACCOUNT_COLUMN_ICONS[account.id];
        return icon ? `${icon} ${account.label}` : account.label;
    }

    function centsFromInput(input) {
        return Core.parseMoneyToCents(input.value);
    }

    function decimalForInput(cents) {
        return Core.centsToDecimalString(cents);
    }

    function currencyFormatter(currency) {
        return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
            style: 'currency',
            currency,
            maximumFractionDigits: 2,
            minimumFractionDigits: 2
        });
    }

    function formatMoney(cents) {
        const usd = cents / 100;
        if (displayCurrency === 'INR' && exchangeRateInr) {
            return currencyFormatter('INR').format(usd * exchangeRateInr);
        }
        return currencyFormatter('USD').format(usd);
    }

    function formatUsd(cents) {
        return currencyFormatter('USD').format(cents / 100);
    }

    function formatPercent(ratio) {
        return `${(ratio * 100).toFixed(2)}%`;
    }

    function updateUnsavedBadge() {
        elements.unsavedBadge.hidden = !hasUnsavedChanges;
    }

    function updateThemeButton() {
        const dark = document.body.classList.contains('dark-mode');
        elements.themeButton.textContent = dark ? '🌙' : '☀️';
        elements.themeButton.title = dark ? 'Switch to light colors' : 'Switch to dark colors';
        elements.themeButton.setAttribute('aria-label', elements.themeButton.title);
    }

    function updateCurrencyButton() {
        const loading = Boolean(fxRequestPromise);
        if (displayCurrency === 'INR' && exchangeRateInr) {
            elements.currencyButton.textContent = 'View USD';
        } else if (exchangeRateInr) {
            elements.currencyButton.textContent = `View INR ($1 = ₹${exchangeRateInr.toFixed(2)})`;
        } else {
            elements.currencyButton.textContent = loading ? 'Loading INR…' : 'View INR';
        }
        elements.currencyButton.disabled = loading;
        elements.refreshRateButton.textContent = loading
            ? '↻ Loading rate…'
            : exchangeRateInr ? `↻ $1 = ₹${exchangeRateInr.toFixed(2)}` : '↻ Fetch INR rate';
        elements.refreshRateButton.disabled = loading;
    }

    function updateLiveLedgerTitle() {
        const formatter = new Intl.DateTimeFormat('en-US', {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        const parts = formatter.formatToParts(new Date());
        const valueFor = (type) => (parts.find((part) => part.type === type) || {}).value || '';
        const dayPeriod = valueFor('dayPeriod').toLowerCase();
        elements.liveLedgerTitle.textContent = `🐼 Family Ledger: ${valueFor('weekday')}, ${valueFor('day')}-${valueFor('month')}-${valueFor('year')}, ${valueFor('hour')}:${valueFor('minute')}:${valueFor('second')} ${dayPeriod}`;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your browser time zone';
        elements.liveLedgerTitle.title = `Live time from ${timeZone}`;
    }

    function addInitialAccountRow(label, amount, removable) {
        const rowId = `initialAccountRow${initialAccountCounter += 1}`;
        const row = makeElement('div', undefined, 'account-row');
        row.dataset.accountRow = rowId;

        const nameGroup = makeElement('div', undefined, 'form-group');
        const nameLabel = makeElement('label', 'Bucket name');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 64;
        nameInput.required = true;
        nameInput.value = label || '';
        nameInput.id = `${rowId}Name`;
        nameInput.dataset.accountLabel = 'true';
        nameLabel.htmlFor = nameInput.id;
        nameGroup.append(nameLabel, nameInput);

        const amountGroup = makeElement('div', undefined, 'form-group');
        const amountLabel = makeElement('label', 'Starting USD');
        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.min = '0';
        amountInput.step = '0.01';
        amountInput.inputMode = 'decimal';
        amountInput.required = true;
        amountInput.value = amount === undefined ? '0.00' : amount;
        amountInput.id = `${rowId}Amount`;
        amountInput.dataset.accountAmount = 'true';
        amountLabel.htmlFor = amountInput.id;
        amountGroup.append(amountLabel, amountInput);

        const remove = makeElement('button', 'Remove', 'btn-outline btn-small remove-account');
        remove.type = 'button';
        remove.disabled = !removable;
        remove.addEventListener('click', () => {
            const rows = elements.initialAccounts.querySelectorAll('[data-account-row]');
            if (rows.length <= 1) {
                setNotice('A new ledger needs at least one bucket.', 'error');
                return;
            }
            row.remove();
        });
        row.append(nameGroup, amountGroup, remove);
        elements.initialAccounts.append(row);
    }

    function setDefaultDates() {
        const today = localIsoDate();
        if (!elements.initialDate.value) elements.initialDate.value = today;
        if (!elements.marketDate.value) elements.marketDate.value = today;
        if (!elements.transferDate.value) elements.transferDate.value = today;
        if (!elements.depositDate.value) elements.depositDate.value = today;
        if (!elements.withdrawalDate.value) elements.withdrawalDate.value = today;
    }

    function resetInitialAccountRows() {
        initialAccountCounter = 0;
        elements.initialAccounts.replaceChildren();
        addInitialAccountRow('Ss', '0.00', false);
        addInitialAccountRow('CkPr', '0.00', true);
        addInitialAccountRow('CpRs', '0.00', true);
    }

    function selectOptions(select, selectedId) {
        const previous = selectedId || select.value;
        select.replaceChildren();
        if (!ledger) return;
        ledger.accounts.forEach((account) => {
            const option = document.createElement('option');
            option.value = account.id;
            option.textContent = account.label;
            select.append(option);
        });
        if (ledger.accounts.some((account) => account.id === previous)) {
            select.value = previous;
        }
    }

    function eventDescription(record) {
        if (record.type === Core.EVENT_TYPES.INITIAL) return 'Initial balance';
        if (record.type === Core.EVENT_TYPES.MARKET) return 'Market valuation update';
        if (record.type === Core.EVENT_TYPES.TRANSFER) return `Reallocation: ${accountLabel(record.from)} → ${accountLabel(record.to)}`;
        if (record.type === Core.EVENT_TYPES.DEPOSIT) return `New funds added to ${accountLabel(record.account)}`;
        if (record.type === Core.EVENT_TYPES.WITHDRAWAL) return `Withdrawal from ${accountLabel(record.account)}`;
        return record.type;
    }

    function appendCell(row, value, className) {
        const cell = makeElement('td', value, className);
        row.append(cell);
        return cell;
    }

    function appendAmountCell(row, cents, ratio) {
        const cell = appendCell(row, formatMoney(cents), 'num');
        const split = makeElement('span', formatPercent(ratio), 'percent-subtext');
        cell.append(split);
        return cell;
    }

    function renderTable() {
        const headRow = document.createElement('tr');
        ['Serial #', 'Date', 'Event type', 'Withdrawn'].forEach((title, index) => {
            const heading = makeElement('th', title, index === 3 ? 'num' : '');
            headRow.append(heading);
        });
        if (ledger) {
            ledger.accounts.forEach((account) => {
                const heading = makeElement('th', accountColumnLabel(account), 'num');
                const subtext = makeElement('span', '(% split)', 'percent-subtext');
                heading.append(document.createElement('br'), subtext);
                headRow.append(heading);
            });
        }
        headRow.append(makeElement('th', 'Total balance', 'num'), makeElement('th', 'Actions'));
        elements.ledgerHead.replaceChildren(headRow);
        elements.tableBody.replaceChildren();

        if (!ledger || !replay || replay.records.length === 0) {
            const row = document.createElement('tr');
            const cell = makeElement('td', 'No ledger is loaded. Start a new ledger or load a JSON backup.', 'empty-cell');
            cell.colSpan = 6;
            row.append(cell);
            elements.tableBody.append(row);
            return;
        }

        replay.records.slice().reverse().forEach((record) => {
            const row = document.createElement('tr');
            appendCell(row, `#${record.serial}`);
            appendCell(row, record.date);
            appendCell(row, eventDescription(record));
            appendCell(row, record.withdrawalCents ? formatMoney(record.withdrawalCents) : formatMoney(0), record.withdrawalCents ? 'num withdrawn' : 'num');
            ledger.accounts.forEach((account) => appendAmountCell(row, record.balancesCents[account.id], record.ratios[account.id]));
            appendCell(row, formatMoney(record.totalCents), 'num');

            const actions = document.createElement('td');
            actions.className = 'action-cell';
            const edit = makeElement('button', 'Edit', 'btn-warning btn-small');
            edit.type = 'button';
            edit.addEventListener('click', () => openEditRecord(record.serial));
            actions.append(edit);
            if (record.type !== Core.EVENT_TYPES.INITIAL) {
                const remove = makeElement('button', 'Delete', 'btn-danger btn-small');
                remove.type = 'button';
                remove.addEventListener('click', () => deleteRecord(record.serial));
                actions.append(remove);
            }
            row.append(actions);
            elements.tableBody.append(row);
        });
    }

    function renderDashboard() {
        const hasLedger = Boolean(ledger && replay && replay.latest);
        elements.initialSetupSection.hidden = hasLedger;
        elements.entrySection.hidden = !hasLedger;
        if (!hasLedger) {
            elements.ratioDisplay.textContent = 'Start a new ledger or load a JSON backup.';
            elements.totalWithdrawnDisplay.textContent = formatMoney(0);
            elements.totalBalanceDisplay.textContent = formatMoney(0);
            renderTable();
            updateUnsavedBadge();
            updateCurrencyButton();
            return;
        }

        const latest = replay.latest;
        const ratios = ledger.accounts.map((account) => `${account.label}: ${formatPercent(latest.ratios[account.id])}`);
        elements.ratioDisplay.textContent = `Current active split — ${ratios.join(' | ')}`;
        elements.totalWithdrawnDisplay.textContent = formatMoney(replay.lifetimeWithdrawnCents);
        elements.totalBalanceDisplay.textContent = formatMoney(latest.totalCents);
        selectOptions(elements.transferFrom);
        selectOptions(elements.transferTo);
        selectOptions(elements.depositAccount);
        if (elements.transferFrom.value === elements.transferTo.value && ledger.accounts.length > 1) {
            elements.transferTo.value = ledger.accounts.find((account) => account.id !== elements.transferFrom.value).id;
        }
        renderTable();
        updateUnsavedBadge();
        updateCurrencyButton();
    }

    function commitDocument(candidate, message, options) {
        const calculated = Core.validateAndReplay(candidate);
        ledger = calculated.document;
        replay = calculated;
        hasUnsavedChanges = !(options && options.saved === true);
        renderDashboard();
        if (message) setNotice(message, options && options.noticeKind);
        return calculated;
    }

    function createNewLedger(event) {
        event.preventDefault();
        try {
            assertCoreIsAvailable();
            const rows = Array.from(elements.initialAccounts.querySelectorAll('[data-account-row]'));
            if (rows.length === 0) throw new Error('Add at least one bucket.');
            const accounts = [];
            const amountsCents = {};
            rows.forEach((row) => {
                const label = normalizedBucketLabel(row.querySelector('[data-account-label]').value);
                if (accounts.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
                    throw new Error(`Bucket name "${label}" is duplicated.`);
                }
                const id = uniqueAccountId(label, accounts);
                const amountCents = centsFromInput(row.querySelector('[data-account-amount]'));
                if (amountCents < 0) throw new Error('Starting balances cannot be negative.');
                accounts.push({ id, label });
                amountsCents[id] = amountCents;
            });
            const document = Core.createLedger({
                accounts,
                metadata: { createdAt: new Date().toISOString(), applicationVersion: APP_VERSION }
            });
            document.records = [Core.makeInitialRecord({
                serial: Core.nextSerial(document.records),
                date: elements.initialDate.value,
                amountsCents
            })];
            commitDocument(document, 'New ledger started. Save a JSON backup after your first updates.');
        } catch (error) {
            reportError('Could not start the ledger', error);
        }
    }

    function candidateWithAppendedRecord(record) {
        const candidate = clone(ledger);
        candidate.records.push(record);
        return candidate;
    }

    function createMarketUpdate(event) {
        event.preventDefault();
        try {
            const totalCents = centsFromInput(elements.marketTotal);
            const record = Core.makeMarketRecord({
                serial: Core.nextSerial(ledger.records),
                date: elements.marketDate.value,
                totalCents
            });
            const candidate = candidateWithAppendedRecord(record);
            const calculated = Core.validateAndReplay(candidate);
            if (totalCents > MAX_LIMIT_CENTS) {
                pendingMarketDocument = calculated.document;
                openBalanceReview(calculated, record.date);
                return;
            }
            commitDocument(calculated.document, 'Market valuation recorded.');
            elements.marketTotal.value = '';
        } catch (error) {
            reportError('Could not record the market valuation', error);
        }
    }

    function createTransfer(event) {
        event.preventDefault();
        try {
            const record = Core.makeTransferRecord({
                serial: Core.nextSerial(ledger.records),
                date: elements.transferDate.value,
                from: elements.transferFrom.value,
                to: elements.transferTo.value,
                amountCents: centsFromInput(elements.transferAmount)
            });
            commitDocument(candidateWithAppendedRecord(record), 'Transfer recorded and split recalculated.');
            elements.transferAmount.value = '';
        } catch (error) {
            reportError('Could not record the transfer', error);
        }
    }

    function createDeposit(event) {
        event.preventDefault();
        try {
            const record = Core.makeDepositRecord({
                serial: Core.nextSerial(ledger.records),
                date: elements.depositDate.value,
                account: elements.depositAccount.value,
                amountCents: centsFromInput(elements.depositAmount)
            });
            const account = accountById(record.account);
            commitDocument(candidateWithAppendedRecord(record), `New funds were added to ${account ? account.label : record.account}; the split was recalculated.`);
            elements.depositAmount.value = '';
        } catch (error) {
            reportError('Could not add the new funds', error);
        }
    }

    function addBucket(event) {
        event.preventDefault();
        try {
            const label = normalizedBucketLabel(elements.bucketLabel.value);
            if (ledger.accounts.some((account) => account.label.toLowerCase() === label.toLowerCase())) {
                throw new Error(`Bucket name "${label}" already exists.`);
            }
            const id = uniqueAccountId(label, ledger.accounts);
            commitDocument(Core.addAccount(ledger, { id, label }), `${label} was added at $0.00. Use a transfer or Add new funds to fund it.`);
            elements.bucketLabel.value = '';
        } catch (error) {
            reportError('Could not add the bucket', error);
        }
    }

    function openBalanceReview(calculated, date) {
        const latest = calculated.latest;
        const excess = latest.totalCents - MAX_LIMIT_CENTS;
        elements.overflowMessage.textContent = `The new balance is ${formatUsd(latest.totalCents)}, which is ${formatUsd(excess)} above the $500,000 reminder threshold.`;
        const preferred = calculated.document.accounts.find((account) => account.id.toLowerCase() === 'cprs') || calculated.document.accounts
            .slice()
            .sort((left, right) => latest.balancesCents[right.id] - latest.balancesCents[left.id])[0];
        selectOptionsForDocument(elements.withdrawalAccount, calculated.document, preferred.id);
        elements.withdrawalDate.value = date;
        const defaultAmount = Math.min(excess, latest.balancesCents[preferred.id]);
        elements.withdrawalAmount.value = decimalForInput(defaultAmount);
        openModal('overflowModal');
    }

    function selectOptionsForDocument(select, ledgerDocument, selectedId) {
        select.replaceChildren();
        ledgerDocument.accounts.forEach((account) => {
            const option = document.createElement('option');
            option.value = account.id;
            option.textContent = account.label;
            select.append(option);
        });
        select.value = selectedId;
    }

    function recordOverflowWithdrawal(event) {
        event.preventDefault();
        if (!pendingMarketDocument) return;
        try {
            const record = Core.makeWithdrawalRecord({
                serial: Core.nextSerial(pendingMarketDocument.records),
                date: elements.withdrawalDate.value,
                account: elements.withdrawalAccount.value,
                amountCents: centsFromInput(elements.withdrawalAmount)
            });
            const candidate = clone(pendingMarketDocument);
            candidate.records.push(record);
            // Validate before clearing the pending market update so a typo in
            // the withdrawal form cannot make the pending update disappear.
            const calculated = Core.validateAndReplay(candidate);
            pendingMarketDocument = null;
            closeModal('overflowModal', true);
            commitDocument(calculated.document, 'Market valuation and withdrawal recorded.');
            elements.marketTotal.value = '';
        } catch (error) {
            reportError('Could not record the withdrawal', error);
        }
    }

    function keepExcess() {
        if (!pendingMarketDocument) return;
        const candidate = pendingMarketDocument;
        pendingMarketDocument = null;
        closeModal('overflowModal', true);
        try {
            commitDocument(candidate, 'Market valuation recorded. The balance remains above the family reminder threshold.');
            elements.marketTotal.value = '';
        } catch (error) {
            reportError('Could not record the market valuation', error);
        }
    }

    function formGroup(labelText, control) {
        const group = makeElement('div', undefined, 'form-group');
        const label = makeElement('label', labelText);
        label.htmlFor = control.id;
        group.append(label, control);
        return group;
    }

    function dateControl(id, value) {
        const control = document.createElement('input');
        control.id = id;
        control.type = 'date';
        control.required = true;
        control.value = value;
        return control;
    }

    function moneyControl(id, cents) {
        const control = document.createElement('input');
        control.id = id;
        control.type = 'number';
        control.min = '0.01';
        control.step = '0.01';
        control.inputMode = 'decimal';
        control.required = true;
        control.value = decimalForInput(cents);
        return control;
    }

    function accountSelectControl(id, selectedId) {
        const control = document.createElement('select');
        control.id = id;
        control.required = true;
        selectOptions(control, selectedId);
        return control;
    }

    function openEditRecord(serial) {
        const record = ledger.records.find((entry) => entry.serial === serial);
        if (!record) return;
        editingSerial = serial;
        const fields = elements.editRecordFields;
        fields.replaceChildren();
        fields.append(formGroup('Date', dateControl('editRecordDate', record.date)));
        if (record.type === Core.EVENT_TYPES.INITIAL) {
            elements.editRecordHint.textContent = 'Changing the baseline recalculates every later entry.';
            ledger.accounts.forEach((account) => {
                const current = record.amountsCents[account.id] || 0;
                const control = moneyControl(`editInitial_${account.id}`, current);
                control.min = '0';
                fields.append(formGroup(`${account.label} starting balance (USD)`, control));
            });
        } else if (record.type === Core.EVENT_TYPES.MARKET) {
            elements.editRecordHint.textContent = 'This is the absolute combined market total on the selected date.';
            fields.append(formGroup('New total account value (USD)', moneyControl('editMarketTotal', record.totalCents)));
        } else if (record.type === Core.EVENT_TYPES.DEPOSIT) {
            elements.editRecordHint.textContent = 'Fresh funds increase this bucket and the combined total at this point in the history.';
            fields.append(formGroup('Add to bucket', accountSelectControl('editDepositAccount', record.account)));
            fields.append(formGroup('New funds (USD)', moneyControl('editDepositAmount', record.amountCents)));
        } else if (record.type === Core.EVENT_TYPES.TRANSFER) {
            elements.editRecordHint.textContent = 'The source must have enough balance at this point in the history.';
            fields.append(formGroup('From bucket', accountSelectControl('editTransferFrom', record.from)));
            fields.append(formGroup('To bucket', accountSelectControl('editTransferTo', record.to)));
            fields.append(formGroup('Amount (USD)', moneyControl('editTransferAmount', record.amountCents)));
        } else if (record.type === Core.EVENT_TYPES.WITHDRAWAL) {
            elements.editRecordHint.textContent = 'The selected bucket must retain a non-negative balance.';
            fields.append(formGroup('Withdraw from', accountSelectControl('editWithdrawalAccount', record.account)));
            fields.append(formGroup('Withdrawal amount (USD)', moneyControl('editWithdrawalAmount', record.amountCents)));
        }
        openModal('editRecordModal');
    }

    function saveEditedRecord(event) {
        event.preventDefault();
        const oldRecord = ledger && ledger.records.find((record) => record.serial === editingSerial);
        if (!oldRecord) return;
        try {
            const date = byId('editRecordDate').value;
            let replacement;
            if (oldRecord.type === Core.EVENT_TYPES.INITIAL) {
                const amountsCents = {};
                ledger.accounts.forEach((account) => {
                    const amount = centsFromInput(byId(`editInitial_${account.id}`));
                    if (amount < 0) throw new Error('Starting balances cannot be negative.');
                    amountsCents[account.id] = amount;
                });
                replacement = Core.makeInitialRecord({ serial: oldRecord.serial, date, amountsCents });
            } else if (oldRecord.type === Core.EVENT_TYPES.MARKET) {
                replacement = Core.makeMarketRecord({ serial: oldRecord.serial, date, totalCents: centsFromInput(byId('editMarketTotal')) });
            } else if (oldRecord.type === Core.EVENT_TYPES.DEPOSIT) {
                replacement = Core.makeDepositRecord({
                    serial: oldRecord.serial,
                    date,
                    account: byId('editDepositAccount').value,
                    amountCents: centsFromInput(byId('editDepositAmount'))
                });
            } else if (oldRecord.type === Core.EVENT_TYPES.TRANSFER) {
                replacement = Core.makeTransferRecord({
                    serial: oldRecord.serial,
                    date,
                    from: byId('editTransferFrom').value,
                    to: byId('editTransferTo').value,
                    amountCents: centsFromInput(byId('editTransferAmount'))
                });
            } else {
                replacement = Core.makeWithdrawalRecord({
                    serial: oldRecord.serial,
                    date,
                    account: byId('editWithdrawalAccount').value,
                    amountCents: centsFromInput(byId('editWithdrawalAmount'))
                });
            }
            const candidate = clone(ledger);
            candidate.records = candidate.records.map((record) => record.serial === editingSerial ? replacement : record);
            commitDocument(candidate, 'Ledger entry updated and history recalculated.');
            closeModal('editRecordModal', true);
            editingSerial = null;
        } catch (error) {
            reportError('Could not save the edit', error);
        }
    }

    function deleteRecord(serial) {
        const record = ledger && ledger.records.find((entry) => entry.serial === serial);
        if (!record || record.type === Core.EVENT_TYPES.INITIAL) return;
        if (!window.confirm(`Delete ledger entry #${serial}? Later entries must still remain valid.`)) return;
        try {
            const candidate = clone(ledger);
            candidate.records = candidate.records.filter((entry) => entry.serial !== serial);
            commitDocument(candidate, `Ledger entry #${serial} was deleted and history recalculated.`);
        } catch (error) {
            reportError('This entry cannot be deleted because it would make later history invalid', error);
        }
    }

    function openModal(id) {
        const modal = byId(id);
        lastFocusedElement = document.activeElement;
        modal.hidden = false;
        const focusable = focusableModalControls(modal);
        if (focusable.length) window.setTimeout(() => focusable[0].focus(), 0);
    }

    function closeModal(id, suppressOverflowDiscard) {
        const modal = byId(id);
        if (id === 'overflowModal' && pendingMarketDocument && !suppressOverflowDiscard) {
            pendingMarketDocument = null;
            setNotice('The over-limit market update was not recorded.', '');
        }
        modal.hidden = true;
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();
    }

    function visibleModal() {
        return ['overflowModal', 'editRecordModal', 'helpModal']
            .map((id) => byId(id))
            .find((modal) => modal && !modal.hidden) || null;
    }

    function focusableModalControls(modal) {
        return Array.from(modal.querySelectorAll('button, input, select, textarea, [tabindex]'))
            .filter((control) => !control.disabled && !control.hidden && control.getAttribute('tabindex') !== '-1');
    }

    function trapModalFocus(event) {
        if (event.key !== 'Tab') return;
        const modal = visibleModal();
        if (!modal) return;
        const controls = focusableModalControls(modal);
        if (!controls.length) {
            event.preventDefault();
            return;
        }
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!modal.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        }
    }

    function fileText(file) {
        if (typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('The selected file could not be read.'));
            reader.onload = () => resolve(reader.result);
            reader.readAsText(file);
        });
    }

    async function importJson(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) {
            setNotice(`Import was not started: this file is larger than the ${MAX_IMPORT_BYTES / (1024 * 1024)} MB safety limit.`, 'error');
            return;
        }
        const hadUnsavedChangesAtStart = hasUnsavedChanges;
        const ledgerAtStart = ledger;
        if (hadUnsavedChangesAtStart && !window.confirm('Replace your unsaved in-memory ledger with this file? Save JSON first if you want to keep the current changes.')) return;
        try {
            // Some editors write a UTF-8 byte-order mark; accepting it keeps
            // family backups portable without loosening JSON validation.
            const raw = await fileText(file);
            const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
            const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
            if (!Array.isArray(records)) throw new Error('The file must be a Family Ledger JSON backup with a records array.');
            if (records.length > MAX_IMPORT_RECORDS) throw new Error(`The file contains more than ${MAX_IMPORT_RECORDS} records and was not loaded.`);
            const calculated = Core.validateAndReplay(parsed);
            // File reads are asynchronous. If the user made a new in-memory
            // change while a file was being read, obtain a fresh replacement
            // confirmation rather than silently discarding that change.
            if (ledger !== ledgerAtStart && hasUnsavedChanges
                && !window.confirm('New unsaved changes were made while this file was loading. Replace them with the selected file?')) return;
            // A pending over-limit review belongs to the current ledger only.
            // An imported file starts a fresh session, so it must never later
            // be overwritten by an old pending market calculation.
            const overflowWasOpen = !elements.overflowModal.hidden;
            pendingMarketDocument = null;
            if (overflowWasOpen) closeModal('overflowModal', true);
            ledger = calculated.document;
            replay = calculated;
            const migratedLegacy = Array.isArray(parsed);
            // A schema-v2 file can still be normalized (for example, sorted
            // chronologically) during validation. Flag that as needing a save
            // instead of silently claiming the normalized in-memory state was
            // already written to disk.
            const normalizedOnLoad = !migratedLegacy && JSON.stringify(parsed) !== JSON.stringify(calculated.document);
            hasUnsavedChanges = migratedLegacy || normalizedOnLoad;
            displayCurrency = 'USD';
            renderDashboard();
            if (migratedLegacy) {
                setNotice('Legacy JSON was safely migrated to the v2 cent-based format in memory. Save a new JSON backup to keep the upgrade.', 'success');
            } else if (normalizedOnLoad) {
                setNotice(`Loaded ${calculated.records.length} entries and normalized their canonical order. Save JSON to keep that normalization.`, 'success');
            } else {
                setNotice(`Loaded ${calculated.records.length} validated ledger entries.`, 'success');
            }
        } catch (error) {
            reportError('The current ledger was kept; the selected file was not loaded', error);
        }
    }

    function startAnotherLedger() {
        const newWindow = window.open(window.location.href, '_blank');
        if (!newWindow) {
            setNotice('A new ledger window could not be opened. Allow pop-ups for this local page, then try again.', 'error');
            return;
        }
        try {
            newWindow.opener = null;
            newWindow.focus();
        } catch (error) {
            // The new tab still has a blank, independent in-memory ledger.
        }
        setNotice('A separate blank ledger window was opened. This ledger remains unchanged.', 'success');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.className = 'download-link';
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    async function saveJson() {
        if (!ledger) return;
        try {
            const data = Core.serializeLedger(ledger, { applicationVersion: APP_VERSION });
            const filename = `Family_Ledger_as_on_${timestampForFilename()}.json`;
            if (typeof window.showSaveFilePicker === 'function') {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: 'Family Ledger JSON', accept: { 'application/json': ['.json'] } }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(data);
                    await writable.close();
                    hasUnsavedChanges = false;
                    updateUnsavedBadge();
                    setNotice(`JSON backup saved as ${filename}.`, 'success');
                    return;
                } catch (error) {
                    if (error && error.name === 'AbortError') return;
                    // A standard browser download is a safe fallback for
                    // browsers with partial File System Access support.
                }
            }
            downloadBlob(new Blob([data], { type: 'application/json;charset=utf-8' }), filename);
            hasUnsavedChanges = false;
            updateUnsavedBadge();
            setNotice(`JSON download started as ${filename}.`, 'success');
        } catch (error) {
            reportError('Could not save the JSON backup', error);
        }
    }

    function safeSpreadsheetText(value) {
        const text = String(value === undefined || value === null ? '' : value);
        return /^[=+\-@]/.test(text) ? `'${text}` : text;
    }

    function loadExcelJs() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        if (excelJsLoadPromise) return excelJsLoadPromise;
        excelJsLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.dataset.exceljsLoader = 'true';
            script.src = EXCELJS_URL;
            script.integrity = EXCELJS_SRI;
            script.crossOrigin = 'anonymous';
            script.referrerPolicy = 'no-referrer';
            script.onload = () => {
                if (window.ExcelJS) {
                    resolve(window.ExcelJS);
                    return;
                }
                script.remove();
                reject(new Error('The optional Excel library loaded without its expected API.'));
            };
            script.onerror = () => {
                script.remove();
                reject(new Error('The optional Excel library could not be loaded. JSON backups continue to work offline.'));
            };
            document.head.append(script);
        }).catch((error) => {
            // Clear a failed attempt so a later click can retry after the
            // connection comes back. This keeps Excel optional and JSON-first.
            excelJsLoadPromise = null;
            throw error;
        });
        return excelJsLoadPromise;
    }

    function excelDisplayValue(cents) {
        const usd = cents / 100;
        return displayCurrency === 'INR' && exchangeRateInr ? usd * exchangeRateInr : usd;
    }

    function excelColumnName(columnNumber) {
        let remaining = columnNumber;
        let result = '';
        while (remaining > 0) {
            const remainder = (remaining - 1) % 26;
            result = String.fromCharCode(65 + remainder) + result;
            remaining = Math.floor((remaining - 1) / 26);
        }
        return result;
    }

    async function exportExcel() {
        if (!ledger || !replay) return;
        if (!window.ExcelJS && !window.confirm('Excel export loads a pinned third-party Excel library from cdnjs. No ledger values are intentionally sent. Continue?')) return;
        try {
            setNotice('Preparing the optional Excel export…');
            const ExcelJS = await loadExcelJs();
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Ledger Dashboard');
            const currency = displayCurrency === 'INR' && exchangeRateInr ? 'INR' : 'USD';
            const moneyFormat = currency === 'INR' ? '"₹"#,##0.00' : '"$"#,##0.00';
            const headers = ['Serial #', 'Date', 'Event type', 'Withdrawn'];
            ledger.accounts.forEach((account) => {
                headers.push(safeSpreadsheetText(account.label), `${safeSpreadsheetText(account.label)} split`);
            });
            headers.push('Total balance');
            worksheet.columns = headers.map((header, index) => ({ header, width: index === 2 ? 34 : 16 }));
            const lastColumn = excelColumnName(headers.length);
            worksheet.mergeCells(`A1:${lastColumn}1`);
            const title = worksheet.getCell('A1');
            title.value = 'Family Ledger — Financial Dashboard';
            title.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } };
            title.alignment = { horizontal: 'center', vertical: 'middle' };
            worksheet.getRow(1).height = 28;
            worksheet.getCell('A2').value = 'Currency';
            worksheet.getCell('B2').value = currency;
            worksheet.getCell('D2').value = 'Exported UTC';
            worksheet.getCell('E2').value = new Date().toISOString();
            if (currency === 'INR') {
                worksheet.getCell('G2').value = 'USD/INR rate';
                worksheet.getCell('H2').value = exchangeRateInr;
                worksheet.getCell('I2').value = 'Rate fetched UTC';
                worksheet.getCell('J2').value = exchangeRateFetchedAt || '';
            }
            worksheet.getCell('A3').value = 'Rounding';
            worksheet.getCell('B3').value = safeSpreadsheetText(Core.ROUNDING_RULE);
            worksheet.mergeCells(`B3:${lastColumn}3`);
            const headerRow = worksheet.getRow(5);
            headerRow.values = headers;
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
            headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
            replay.records.slice().reverse().forEach((record) => {
                const values = [record.serial, record.date, safeSpreadsheetText(eventDescription(record)), excelDisplayValue(record.withdrawalCents || 0)];
                ledger.accounts.forEach((account) => {
                    values.push(excelDisplayValue(record.balancesCents[account.id]), record.ratios[account.id]);
                });
                values.push(excelDisplayValue(record.totalCents));
                const row = worksheet.addRow(values);
                row.getCell(4).numFmt = moneyFormat;
                let column = 5;
                ledger.accounts.forEach(() => {
                    row.getCell(column).numFmt = moneyFormat;
                    row.getCell(column + 1).numFmt = '0.00%';
                    column += 2;
                });
                row.getCell(column).numFmt = moneyFormat;
            });
            for (let row = 5; row <= worksheet.rowCount; row += 1) {
                for (let column = 1; column <= headers.length; column += 1) {
                    worksheet.getCell(row, column).border = {
                        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
                    };
                }
            }
            const buffer = await workbook.xlsx.writeBuffer();
            const filename = `Family_Ledger_as_on_${timestampForFilename()}.xlsx`;
            downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
            setNotice(`Excel download started as ${filename}. JSON remains the canonical backup.`, 'success');
        } catch (error) {
            reportError('Could not export Excel', error);
        }
    }

    function refreshExchangeRate(options) {
        if (fxRequestPromise) return fxRequestPromise;
        const settings = Object.assign({ automatic: false, showInrAfterFetch: false }, options);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 8_000);
        fxRequestPromise = (async () => {
            try {
                const response = await fetch(FX_ENDPOINT, {
                    method: 'GET',
                    cache: 'no-store',
                    referrerPolicy: 'no-referrer',
                    signal: controller.signal,
                    headers: { Accept: 'application/json' }
                });
                if (!response.ok) throw new Error(`The rate service returned HTTP ${response.status}.`);
                const payload = await response.json();
                const rate = Number(payload && payload.rates && payload.rates.INR);
                if (!Number.isFinite(rate) || rate <= 0 || rate > 10_000) throw new Error('The rate service returned an invalid INR rate.');
                exchangeRateInr = rate;
                exchangeRateFetchedAt = new Date().toISOString();
                if (settings.showInrAfterFetch) displayCurrency = 'INR';
                renderDashboard();
                if (!settings.automatic) {
                    setNotice(`USD/INR rate refreshed: $1 = ₹${exchangeRateInr.toFixed(2)}. JSON remains USD.`, 'success');
                }
                return true;
            } catch (error) {
                if (settings.automatic) {
                    setNotice('Could not automatically load the USD/INR rate. Use the ↻ rate button to try again; ledger work remains available offline.', 'error');
                } else {
                    reportError('Could not refresh the USD/INR rate', error);
                }
                return false;
            } finally {
                window.clearTimeout(timeout);
            }
        })();
        updateCurrencyButton();
        fxRequestPromise.finally(() => {
            fxRequestPromise = null;
            updateCurrencyButton();
        });
        return fxRequestPromise;
    }

    async function toggleCurrency() {
        if (displayCurrency === 'INR' && exchangeRateInr) {
            displayCurrency = 'USD';
            renderDashboard();
            setNotice('Showing canonical USD values.');
            return;
        }
        if (exchangeRateInr) {
            displayCurrency = 'INR';
            renderDashboard();
            setNotice(`Showing INR estimates at $1 = ₹${exchangeRateInr.toFixed(2)}. JSON remains USD.`);
            return;
        }
        await refreshExchangeRate({ showInrAfterFetch: true });
    }

    function refreshRateButtonClicked() {
        void refreshExchangeRate();
    }

    function toggleTheme() {
        const dark = document.body.classList.toggle('dark-mode');
        try {
            window.localStorage.setItem('ledger_theme', dark ? 'dark' : 'light');
        } catch (error) {
            // Theme persistence is optional; no ledger data is stored here.
        }
        updateThemeButton();
    }

    function wireEvents() {
        elements.initialForm.addEventListener('submit', createNewLedger);
        elements.addInitialAccountButton.addEventListener('click', () => addInitialAccountRow('', '0.00', true));
        elements.initialLoadJsonButton.addEventListener('click', () => elements.importFile.click());
        elements.marketForm.addEventListener('submit', createMarketUpdate);
        elements.transferForm.addEventListener('submit', createTransfer);
        elements.depositForm.addEventListener('submit', createDeposit);
        elements.addBucketForm.addEventListener('submit', addBucket);
        elements.withdrawalForm.addEventListener('submit', recordOverflowWithdrawal);
        elements.keepExcessButton.addEventListener('click', keepExcess);
        elements.editRecordForm.addEventListener('submit', saveEditedRecord);
        elements.loadJsonButton.addEventListener('click', () => elements.importFile.click());
        elements.importFile.addEventListener('change', importJson);
        elements.saveJsonButton.addEventListener('click', saveJson);
        elements.exportExcelButton.addEventListener('click', exportExcel);
        elements.newLedgerButton.addEventListener('click', startAnotherLedger);
        elements.currencyButton.addEventListener('click', toggleCurrency);
        elements.refreshRateButton.addEventListener('click', refreshRateButtonClicked);
        elements.themeButton.addEventListener('click', toggleTheme);
        elements.helpButton.addEventListener('click', () => openModal('helpModal'));
        document.querySelectorAll('[data-close-modal]').forEach((button) => {
            button.addEventListener('click', () => closeModal(button.dataset.closeModal));
        });
        ['overflowModal', 'editRecordModal', 'helpModal'].forEach((id) => {
            const modal = byId(id);
            modal.addEventListener('mousedown', (event) => {
                if (event.target === modal) closeModal(id);
            });
        });
        document.addEventListener('keydown', (event) => {
            trapModalFocus(event);
            if (event.key !== 'Escape') return;
            const modal = visibleModal();
            if (modal) closeModal(modal.id);
        });
        window.addEventListener('beforeunload', (event) => {
            if (!hasUnsavedChanges) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    function initializeElements() {
        [
            'initialSetupSection', 'entrySection', 'initialForm', 'initialDate', 'initialAccounts', 'addInitialAccountButton', 'initialLoadJsonButton',
            'marketForm', 'marketDate', 'marketTotal', 'transferForm', 'transferDate', 'transferFrom', 'transferTo', 'transferAmount',
            'depositForm', 'depositDate', 'depositAccount', 'depositAmount',
            'addBucketForm', 'bucketLabel', 'loadJsonButton', 'saveJsonButton', 'exportExcelButton', 'newLedgerButton', 'importFile',
            'unsavedBadge', 'themeButton', 'currencyButton', 'refreshRateButton', 'liveLedgerTitle', 'ratioDisplay', 'statusNotice', 'totalWithdrawnDisplay', 'totalBalanceDisplay',
            'ledgerHead', 'tableBody', 'overflowModal', 'overflowMessage', 'withdrawalForm', 'withdrawalDate', 'withdrawalAccount',
            'withdrawalAmount', 'keepExcessButton', 'editRecordModal', 'editRecordForm', 'editRecordFields', 'editRecordHint', 'helpButton'
        ].forEach((id) => { elements[id] = byId(id); });
    }

    function initialize() {
        try {
            assertCoreIsAvailable();
            initializeElements();
            try {
                if (window.localStorage.getItem('ledger_theme') === 'dark') document.body.classList.add('dark-mode');
            } catch (error) {
                // Theme storage is optional.
            }
            updateThemeButton();
            updateLiveLedgerTitle();
            window.setInterval(updateLiveLedgerTitle, 1_000);
            resetInitialAccountRows();
            setDefaultDates();
            wireEvents();
            renderDashboard();
            setNotice('Ledger records remain in this browser until you save a file. The USD/INR rate is refreshing automatically; Excel export loads only when you choose it.');
            void refreshExchangeRate({ automatic: true });
        } catch (error) {
            const target = byId('statusNotice');
            if (target) {
                target.textContent = `Family Ledger could not start: ${errorText(error)}`;
                target.className = 'notice error';
            }
        }
    }

    initialize();
}());
