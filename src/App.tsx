import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { loadCloudWorkspace, saveCloudWorkspace, supabaseEnabled } from './cloudStorage';
import * as XLSX from 'xlsx';
import {
  type Entry,
  type EntryKind,
  type WorkspaceState,
  connectWorkspaceFile,
  createBook,
  createDefaultWorkspace,
  loadWorkspaceState,
  normalizeWorkspacePayload,
  saveWorkspaceState,
} from './workspaceStorage';

type EntryDraft = {
  kind: EntryKind;
  amount: string;
  category: string;
  note: string;
  date: string;
};

type Filters = {
  search: string;
  kind: 'all' | EntryKind;
  month: string;
};

const EMPTY_DRAFT: EntryDraft = {
  kind: 'income',
  amount: '',
  category: '',
  note: '',
  date: new Date().toISOString().slice(0, 10),
};

const EMPTY_FILTERS: Filters = {
  search: '',
  kind: 'all',
  month: '',
};

function formatMoney(amount: number) {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    maximumFractionDigits: 2,
  }).format(amount);
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function stripFileExtension(fileName: string) {
  const baseName = fileName.replace(/\.[^.]+$/, '').trim();
  return baseName || 'Imported Book';
}

function pickCellValue(row: Record<string, unknown>, aliases: string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([key]) => normalizeText(key) === normalizeText(alias));
    if (found) {
      return found[1];
    }
  }

  return undefined;
}

function parseSpreadsheetAmount(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    return Number.NaN;
  }

  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseSignedAmount(value: unknown, direction: 'debit' | 'credit') {
  const amount = parseSpreadsheetAmount(value);
  if (!Number.isFinite(amount)) {
    return Number.NaN;
  }

  const absoluteAmount = Math.abs(amount);
  return direction === 'debit' ? -absoluteAmount : absoluteAmount;
}

function parseSpreadsheetDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function parseSpreadsheetKind(value: unknown, amount: number): EntryKind {
  const text = normalizeText(String(value));

  if (text.includes('out') || text.includes('debit') || text.includes('expense') || text.includes('-')) {
    return 'outcome';
  }

  if (text.includes('in') || text.includes('credit') || text.includes('income') || text.includes('+')) {
    return 'income';
  }

  return amount < 0 ? 'outcome' : 'income';
}

function parseSpreadsheetRows(rows: Array<Record<string, unknown>>, bookId: string): Entry[] {
  return rows
    .map((row) => {
      const debitValue = pickCellValue(row, ['debit', 'out', 'withdrawal', 'paid', 'payment', 'expense', 'outcome']);
      const creditValue = pickCellValue(row, ['credit', 'in', 'deposit', 'received', 'receipt', 'income']);
      const rawAmount = pickCellValue(row, ['amount', 'value', 'money', 'total', 'balance', 'transaction amount']);

      let amount = parseSpreadsheetAmount(rawAmount);
      if (!Number.isFinite(amount)) {
        const debitAmount = parseSignedAmount(debitValue, 'debit');
        const creditAmount = parseSignedAmount(creditValue, 'credit');

        if (Number.isFinite(debitAmount)) {
          amount = debitAmount;
        } else if (Number.isFinite(creditAmount)) {
          amount = creditAmount;
        }
      }

      if (!Number.isFinite(amount)) {
        return null;
      }

      const rawDate = pickCellValue(row, ['date', 'transaction date', 'entry date', 'day', 'voucher date']);
      const date = parseSpreadsheetDate(rawDate);
      if (!date) {
        return null;
      }

      const category = String(
        pickCellValue(row, ['category', 'head', 'particular', 'title', 'name', 'ledger', 'account']) ?? 'Imported entry',
      ).trim() || 'Imported entry';
      const note = String(
        pickCellValue(row, ['note', 'remarks', 'description', 'memo', 'narration', 'details']) ?? '',
      ).trim();
      const kind = parseSpreadsheetKind(
        pickCellValue(row, ['type', 'kind', 'transaction type', 'transaction', 'entry type']),
        amount,
      );

      const signedAmount = amount < 0 ? Math.abs(amount) : amount;
      const finalKind =
        Number.isFinite(debitValue as number) || normalizeText(String(debitValue)).length > 0
          ? 'outcome'
          : Number.isFinite(creditValue as number) || normalizeText(String(creditValue)).length > 0
            ? 'income'
            : kind;

      return {
        id: createId(),
        bookId,
        kind: finalKind,
        amount: signedAmount,
        category,
        note,
        date,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } satisfies Entry;
    })
    .filter((entry): entry is Entry => entry !== null);
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createDefaultWorkspace());
  const [draft, setDraft] = useState<EntryDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [bookNameDraft, setBookNameDraft] = useState('');
  const [storageMode, setStorageMode] = useState<'browser' | 'file'>('browser');
  const [cloudMode, setCloudMode] = useState<'off' | 'syncing' | 'connected' | 'error'>(
    supabaseEnabled ? 'syncing' : 'off',
  );
  const [isHydrated, setIsHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadWorkspaceState()
      .then(async ({ state, fileConnected }) => {
        let nextState = state;
        let nextCloudMode: typeof cloudMode = supabaseEnabled ? 'connected' : 'off';

        if (supabaseEnabled) {
          const cloudState = await loadCloudWorkspace();
          if (cloudState) {
            nextState = cloudState;
          }
        }

        if (cancelled) {
          return;
        }

        setWorkspace(nextState);
        setStorageMode(fileConnected ? 'file' : 'browser');
        setCloudMode(nextCloudMode);
        setIsHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setCloudMode(supabaseEnabled ? 'error' : 'off');
          setIsHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    void Promise.all([saveWorkspaceState(workspace), saveCloudWorkspace(workspace)])
      .then(([fileConnected, cloudConnected]) => {
        setStorageMode(fileConnected ? 'file' : 'browser');
        setCloudMode(supabaseEnabled ? (cloudConnected ? 'connected' : 'error') : 'off');
      })
      .catch(() => {
        setCloudMode(supabaseEnabled ? 'error' : 'off');
      });
  }, [isHydrated, workspace]);

  const activeBook = useMemo(() => {
    return workspace.books.find((book) => book.id === workspace.activeBookId) ?? workspace.books[0];
  }, [workspace.activeBookId, workspace.books]);

  const activeEntries = useMemo(() => {
    return workspace.entries.filter((entry) => entry.bookId === activeBook?.id);
  }, [activeBook?.id, workspace.entries]);

  const sortedEntries = useMemo(() => {
    return [...activeEntries].sort((left, right) => {
      const leftTime = new Date(`${left.date}T00:00:00`).getTime();
      const rightTime = new Date(`${right.date}T00:00:00`).getTime();

      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }

      return right.updatedAt - left.updatedAt;
    });
  }, [activeEntries]);

  const visibleEntries = useMemo(() => {
    return sortedEntries.filter((entry) => {
      const matchesKind = filters.kind === 'all' || entry.kind === filters.kind;
      const matchesMonth = !filters.month || entry.date.startsWith(filters.month);
      const haystack = [entry.category, entry.note, entry.date, entry.kind].join(' ').toLowerCase();
      const matchesSearch = !filters.search || haystack.includes(normalizeText(filters.search));

      return matchesKind && matchesMonth && matchesSearch;
    });
  }, [filters, sortedEntries]);

  const totals = useMemo(() => {
    return visibleEntries.reduce(
      (accumulator, entry) => {
        if (entry.kind === 'income') {
          accumulator.income += entry.amount;
        } else {
          accumulator.outcome += entry.amount;
        }

        accumulator.count += 1;
        return accumulator;
      },
      { income: 0, outcome: 0, count: 0 },
    );
  }, [visibleEntries]);

  const categories = useMemo(() => {
    const unique = new Set(activeEntries.map((entry) => entry.category.trim()).filter(Boolean));
    return Array.from(unique).sort((left, right) => left.localeCompare(right));
  }, [activeEntries]);

  const bookSummaries = useMemo(() => {
    return workspace.books
      .map((book) => {
        const bookEntries = workspace.entries.filter((entry) => entry.bookId === book.id);
        const income = bookEntries.reduce((total, entry) => total + (entry.kind === 'income' ? entry.amount : 0), 0);
        const outcome = bookEntries.reduce((total, entry) => total + (entry.kind === 'outcome' ? entry.amount : 0), 0);

        return {
          ...book,
          income,
          outcome,
          balance: income - outcome,
          count: bookEntries.length,
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [workspace.books, workspace.entries]);

  const activeBookSummary = bookSummaries.find((book) => book.id === activeBook?.id) ?? bookSummaries[0];

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function addBook() {
    const name = bookNameDraft.trim();
    if (!name) {
      return;
    }

    const nextBook = createBook(name);
    setWorkspace((current) => ({
      ...current,
      books: [nextBook, ...current.books],
      activeBookId: nextBook.id,
    }));
    setBookNameDraft('');
    resetForm();
    setFilters(EMPTY_FILTERS);
  }

  async function bindDataFile() {
    try {
      const result = await connectWorkspaceFile(workspace);
      setWorkspace(result.state);
      setStorageMode(result.connected ? 'file' : 'browser');
    } catch {
      setStorageMode('browser');
    }
  }

  function selectBook(bookId: string) {
    setWorkspace((current) => ({ ...current, activeBookId: bookId }));
    resetForm();
    setFilters(EMPTY_FILTERS);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const trimmedCategory = draft.category.trim();
    const trimmedNote = draft.note.trim();

    const nextEntry: Entry = {
      id: editingId ?? createId(),
      bookId: activeBook?.id ?? workspace.activeBookId,
      kind: draft.kind,
      amount,
      category: trimmedCategory || (draft.kind === 'income' ? 'General income' : 'General expense'),
      note: trimmedNote,
      date: draft.date,
      createdAt: editingId
        ? workspace.entries.find((entry) => entry.id === editingId)?.createdAt ?? Date.now()
        : Date.now(),
      updatedAt: Date.now(),
    };

    setWorkspace((current) => {
      const withoutEdited = current.entries.filter((entry) => entry.id !== nextEntry.id);
      return { ...current, entries: [nextEntry, ...withoutEdited] };
    });

    resetForm();
  }

  function startEdit(entry: Entry) {
    setEditingId(entry.id);
    setDraft({
      kind: entry.kind,
      amount: entry.amount.toString(),
      category: entry.category,
      note: entry.note,
      date: entry.date,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function removeEntry(id: string) {
    setWorkspace((current) => ({
      ...current,
      entries: current.entries.filter((entry) => entry.id !== id),
    }));
    if (editingId === id) {
      resetForm();
    }
  }

  function exportBackup() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 2,
            exportedAt: new Date().toISOString(),
            ...workspace,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cashbook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function persistImportedWorkspace(nextWorkspace: WorkspaceState) {
    setWorkspace(nextWorkspace);
    setFilters(EMPTY_FILTERS);
    resetForm();

    const [fileConnected, cloudConnected] = await Promise.all([
      saveWorkspaceState(nextWorkspace),
      saveCloudWorkspace(nextWorkspace),
    ]);

    setStorageMode(fileConnected ? 'file' : 'browser');
    setCloudMode(supabaseEnabled ? (cloudConnected ? 'connected' : 'error') : 'off');
  }

  async function handleImport(file: File) {
    try {
      const isExcel = /\.(xlsx|xls)$/i.test(file.name) || file.type.includes('sheet') || file.type.includes('excel');

      if (isExcel) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const sheetName = workbook.SheetNames[0];

        if (!sheetName) {
          throw new Error('Excel workbook is empty');
        }

        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
        const nextBook = createBook(stripFileExtension(file.name));
        const importedEntries = parseSpreadsheetRows(rows, nextBook.id);

        if (importedEntries.length === 0) {
          throw new Error('No rows could be read from the spreadsheet');
        }

        const nextWorkspace: WorkspaceState = {
          books: [nextBook, ...workspace.books],
          entries: [...importedEntries, ...workspace.entries],
          activeBookId: nextBook.id,
        };

        await persistImportedWorkspace(nextWorkspace);
        return;
      }

      const parsed = JSON.parse(await file.text()) as unknown;
      const nextWorkspace = normalizeWorkspacePayload(parsed);

      if (!nextWorkspace) {
        throw new Error('Invalid backup file');
      }

      await persistImportedWorkspace(nextWorkspace);
    } catch {
      alert('This file could not be imported. Please select a valid JSON or Excel file.');
    }
  }

  function clearAll() {
    if (window.confirm('Delete every transaction from this cashbook?')) {
      setWorkspace(createDefaultWorkspace());
      resetForm();
    }
  }

  return (
    <main className="app-shell">
      <section className="panel books-panel">
        <div className="panel-header">
          <div>
            <p className="panel-label">Local-first personal cashbook</p>
            <h2>Switch between your books</h2>
          </div>
          <span className="book-count">{workspace.books.length} books</span>
        </div>

        <div className="books-grid">
          {bookSummaries.map((book) => (
            <button
              key={book.id}
              type="button"
              className={book.id === activeBook?.id ? 'book-card active' : 'book-card'}
              onClick={() => selectBook(book.id)}
            >
              <div>
                <strong>{book.name}</strong>
                <span>{book.count} entries</span>
              </div>
              <div className="book-card-metrics">
                <span>{formatMoney(book.balance)}</span>
                <small>
                  {formatMoney(book.income)} in / {formatMoney(book.outcome)} out
                </small>
              </div>
            </button>
          ))}
        </div>

        <div className="book-creator">
          <label>
            Add new book
            <div className="inline-form">
              <input
                type="text"
                value={bookNameDraft}
                onChange={(event) => setBookNameDraft(event.target.value)}
                placeholder="New book name"
              />
              <button type="button" className="primary-button inline-button" onClick={addBook}>
                Create book
              </button>
            </div>
          </label>
        </div>
      </section>

      <section className="panel net-panel">
        <div className="panel-header panel-header-inline">
          <div>
            <p className="panel-label">Net balance</p>
            <h2>{activeBook?.name ?? 'No book selected'}</h2>
          </div>
          <span className={(activeBookSummary?.balance ?? 0) >= 0 ? 'balance-pill positive' : 'balance-pill negative'}>
            {formatMoney(activeBookSummary?.balance ?? 0)}
          </span>
        </div>

        <div className="hero-stats net-stats">
          <article>
            <span>Income</span>
            <strong>{formatMoney(activeBookSummary?.income ?? 0)}</strong>
          </article>
          <article>
            <span>Outcome</span>
            <strong>{formatMoney(activeBookSummary?.outcome ?? 0)}</strong>
          </article>
          <article>
            <span>Visible entries</span>
            <strong>{activeBookSummary?.count ?? 0}</strong>
          </article>
        </div>
      </section>

      <section className="content-grid">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <div className="panel-header">
            <div>
              <p className="panel-label">Entry editor</p>
              <h2>{editingId ? 'Edit transaction' : 'Add transaction'}</h2>
              <p className="active-book-label">Working in {activeBook?.name ?? 'No book selected'}</p>
            </div>
            {editingId ? (
              <button type="button" className="text-button" onClick={resetForm}>
                Cancel edit
              </button>
            ) : null}
          </div>

          <div className="kind-switch">
            <button
              type="button"
              className={draft.kind === 'income' ? 'active' : ''}
              onClick={() => setDraft((current) => ({ ...current, kind: 'income' }))}
            >
              Income
            </button>
            <button
              type="button"
              className={draft.kind === 'outcome' ? 'active' : ''}
              onClick={() => setDraft((current) => ({ ...current, kind: 'outcome' }))}
            >
              Outcome
            </button>
          </div>

          <label>
            Amount
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={draft.amount}
              onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
              placeholder="0.00"
              required
            />
          </label>

          <label>
            Category
            <input
              list="category-suggestions"
              type="text"
              value={draft.category}
              onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
              placeholder="Salary, rent, groceries, etc."
            />
          </label>

          <label>
            Note
            <textarea
              rows={4}
              value={draft.note}
              onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
              placeholder="Optional note"
            />
          </label>

          <label>
            Date
            <input
              type="date"
              value={draft.date}
              onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))}
              required
            />
          </label>

          <button type="submit" className="primary-button">
            {editingId ? 'Save transaction' : 'Add transaction'}
          </button>

          <datalist id="category-suggestions">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        </form>

        <aside className="panel toolbar-panel">
          <div className="panel-header">
            <div>
              <p className="panel-label">Data controls</p>
              <h2>Keep your records safe</h2>
            </div>
          </div>

          <div className="action-list">
            <button type="button" className="secondary-button" onClick={bindDataFile}>
              {storageMode === 'file' ? 'Reconnect data file' : 'Save data file'}
            </button>
            <button type="button" className="secondary-button" onClick={exportBackup}>
              Export backup
            </button>
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              Import JSON / Excel
            </button>
            <button type="button" className="danger-button" onClick={clearAll}>
              Clear all data
            </button>
          </div>

          <p className="helper-text">
            {storageMode === 'file'
              ? 'Your entries are being saved to a local JSON file and also kept as a browser backup.'
              : 'Your entries are stored locally in this browser. Connect a local data file to keep them on disk across restarts. Importing an Excel file creates its own dedicated book.'}
          </p>

          <p className={`sync-status ${cloudMode}`}>
            <span className="sync-dot" />
            {cloudMode === 'connected'
              ? 'Supabase cloud sync connected'
              : cloudMode === 'syncing'
                ? 'Connecting to Supabase...'
                : cloudMode === 'error'
                  ? 'Supabase needs its database table configured'
                  : 'Cloud sync disabled'}
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                handleImport(file);
              }
              event.target.value = '';
            }}
          />

          <label>
            Search
            <input
              type="search"
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Search category, note, date..."
            />
          </label>

          <div className="two-up">
            <label>
              Type
              <select
                value={filters.kind}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, kind: event.target.value as Filters['kind'] }))
                }
              >
                <option value="all">All</option>
                <option value="income">Income</option>
                <option value="outcome">Outcome</option>
              </select>
            </label>

            <label>
              Month
              <input
                type="month"
                value={filters.month}
                onChange={(event) => setFilters((current) => ({ ...current, month: event.target.value }))}
              />
            </label>
          </div>
        </aside>
      </section>

      <section className="panel table-panel">
        <div className="panel-header">
          <div>
            <p className="panel-label">Transactions</p>
            <h2>{visibleEntries.length} matching entries</h2>
          </div>
        </div>

        {visibleEntries.length === 0 ? (
          <div className="empty-state">
            <h3>No entries yet</h3>
            <p>Start with your first income or outcome entry above. It will be saved locally right away.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Note</th>
                  <th className="right">Amount</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.date}</td>
                    <td>
                      <span className={entry.kind === 'income' ? 'pill income' : 'pill outcome'}>{entry.kind}</span>
                    </td>
                    <td>{entry.category}</td>
                    <td>{entry.note || '—'}</td>
                    <td className={`right ${entry.kind === 'income' ? 'income-text' : 'outcome-text'}`}>
                      {entry.kind === 'income' ? '+' : '-'}{formatMoney(entry.amount)}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="text-button" onClick={() => startEdit(entry)}>
                          Edit
                        </button>
                        <button type="button" className="text-button danger" onClick={() => removeEntry(entry.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;