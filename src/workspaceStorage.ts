export type Book = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type EntryKind = 'income' | 'outcome';

export type Entry = {
  id: string;
  bookId: string;
  kind: EntryKind;
  amount: number;
  category: string;
  note: string;
  date: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceState = {
  books: Book[];
  entries: Entry[];
  activeBookId: string;
};

type WorkspaceLoadResult = {
  state: WorkspaceState;
  fileConnected: boolean;
};

const STORAGE_KEY = 'cashbook-local.workspace.v2';
const LEGACY_ENTRIES_KEY = 'cashbook-local.entries.v1';
const FILE_HANDLE_DB = 'cashbook-local.workspace-file.v1';
const FILE_HANDLE_STORE = 'handles';
const FILE_HANDLE_KEY = 'workspace';
const DEFAULT_BOOK_NAME = 'Main Book';

let cachedFileHandle: FileSystemFileHandle | null = null;

type FileHandleWithPermissions = FileSystemFileHandle & {
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBook(name: string): Book {
  const now = Date.now();
  return {
    id: createId(),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultWorkspace(): WorkspaceState {
  const defaultBook = createBook(DEFAULT_BOOK_NAME);
  return {
    books: [defaultBook],
    entries: [],
    activeBookId: defaultBook.id,
  };
}

function openWorkspaceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(FILE_HANDLE_STORE);
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to open workspace database'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function getSavedFileHandle(): Promise<FileSystemFileHandle | null> {
  if (cachedFileHandle) {
    return cachedFileHandle;
  }

  if (!('indexedDB' in window)) {
    return null;
  }

  const db = await openWorkspaceDb();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_HANDLE_STORE, 'readonly');
      const store = transaction.objectStore(FILE_HANDLE_STORE);
      const request = store.get(FILE_HANDLE_KEY);

      request.onerror = () => reject(request.error ?? new Error('Unable to load workspace file handle'));
      request.onsuccess = () => resolve((request.result as FileSystemFileHandle | undefined) ?? null);
    });
  } finally {
    db.close();
  }
}

async function saveFileHandle(handle: FileSystemFileHandle): Promise<void> {
  cachedFileHandle = handle;

  const db = await openWorkspaceDb();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(FILE_HANDLE_STORE, 'readwrite');
      const store = transaction.objectStore(FILE_HANDLE_STORE);
      const request = store.put(handle, FILE_HANDLE_KEY);

      request.onerror = () => reject(request.error ?? new Error('Unable to save workspace file handle'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save workspace file handle'));
    });
  } finally {
    db.close();
  }
}

async function hasReadWriteAccess(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const permissionHandle = handle as FileHandleWithPermissions;
    const readPermission = await permissionHandle.queryPermission?.({ mode: 'readwrite' });
    if (readPermission === 'granted') {
      return true;
    }

    return (await permissionHandle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

function isEntry(value: unknown): value is Entry {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Entry).id === 'string' &&
      typeof (value as Entry).bookId === 'string' &&
      ((value as Entry).kind === 'income' || (value as Entry).kind === 'outcome') &&
      typeof (value as Entry).amount === 'number' &&
      typeof (value as Entry).category === 'string' &&
      typeof (value as Entry).note === 'string' &&
      typeof (value as Entry).date === 'string',
  );
}

function isBook(value: unknown): value is Book {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Book).id === 'string' &&
      typeof (value as Book).name === 'string' &&
      typeof (value as Book).createdAt === 'number' &&
      typeof (value as Book).updatedAt === 'number',
  );
}

export function normalizeWorkspacePayload(payload: unknown): WorkspaceState | null {
  if (Array.isArray(payload)) {
    const defaultBook = createBook(DEFAULT_BOOK_NAME);
    const entries = payload.filter(isEntry).map((entry) => ({
      ...entry,
      bookId: defaultBook.id,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    }));

    return {
      books: [defaultBook],
      entries,
      activeBookId: defaultBook.id,
    };
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const typedPayload = payload as Partial<WorkspaceState> & { entries?: unknown[]; books?: unknown[] };
  const books = (typedPayload.books ?? []).filter(isBook);

  if (books.length === 0) {
    return null;
  }

  const activeBookId =
    typeof typedPayload.activeBookId === 'string' && books.some((book) => book.id === typedPayload.activeBookId)
      ? typedPayload.activeBookId
      : books[0].id;

  const entries = (typedPayload.entries ?? [])
    .filter(isEntry)
    .map((entry) => ({
      ...entry,
      bookId: books.some((book) => book.id === entry.bookId) ? entry.bookId : activeBookId,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    }));

  return {
    books,
    entries,
    activeBookId,
  };
}

function loadSnapshot(): WorkspaceState | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return normalizeWorkspacePayload(JSON.parse(stored));
    }

    const legacyStored = window.localStorage.getItem(LEGACY_ENTRIES_KEY);
    if (legacyStored) {
      return normalizeWorkspacePayload(JSON.parse(legacyStored));
    }
  } catch {
    return null;
  }

  return null;
}

async function readWorkspaceFromHandle(handle: FileSystemFileHandle): Promise<WorkspaceState | null> {
  if (!(await hasReadWriteAccess(handle))) {
    return null;
  }

  const file = await handle.getFile();
  const content = await file.text();

  if (!content.trim()) {
    return null;
  }

  return normalizeWorkspacePayload(JSON.parse(content));
}

async function ensureWritableHandle(): Promise<FileSystemFileHandle | null> {
  const handle = await getSavedFileHandle();
  if (!handle) {
    return null;
  }

  if (!(await hasReadWriteAccess(handle))) {
    return null;
  }

  cachedFileHandle = handle;
  return handle;
}

export async function loadWorkspaceState(): Promise<WorkspaceLoadResult> {
  let handle: FileSystemFileHandle | null = null;

  try {
    handle = await ensureWritableHandle();
    if (handle) {
      const fromFile = await readWorkspaceFromHandle(handle);
      if (fromFile) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fromFile));
        return {
          state: fromFile,
          fileConnected: true,
        };
      }
    }
  } catch {
    // Fall back to the browser snapshot when file access needs a user gesture.
  }

  const snapshot = loadSnapshot() ?? createDefaultWorkspace();
  return {
    state: snapshot,
    fileConnected: Boolean(handle),
  };
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<boolean> {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  let handle: FileSystemFileHandle | null = null;
  try {
    handle = await ensureWritableHandle();
  } catch {
    return false;
  }

  if (!handle) {
    return false;
  }

  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
    return true;
  } catch {
    await writable.abort().catch(() => undefined);
    return false;
  }
}

export async function connectWorkspaceFile(
  state: WorkspaceState,
): Promise<{ connected: boolean; state: WorkspaceState }> {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;

  if (!picker) {
    return { connected: false, state };
  }

  const handle = await picker({
    suggestedName: 'cashbook-data.json',
    types: [
      {
        description: 'Cashbook data file',
        accept: {
          'application/json': ['.json'],
        },
      },
    ],
  });

  const existingState = await readWorkspaceFromHandle(handle);
  const nextState = existingState ?? state;

  cachedFileHandle = handle;
  await saveFileHandle(handle);
  await saveWorkspaceState(nextState);
  return { connected: true, state: nextState };
}