export type SavedRecording = { id: string; name: string; createdAt: number; size: number; blob: Blob }

const DATABASE = 'song-to-midi-recordings'
const STORE = 'recordings'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open saved recordings.'))
  })
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode)
      const request = action(transaction.objectStore(STORE))
      let result: T
      request.onsuccess = () => { result = request.result }
      request.onerror = () => reject(request.error ?? new Error('Recording storage failed.'))
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error('Recording storage failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording storage was cancelled.'))
    })
  } finally { database.close() }
}

export async function listRecordings(): Promise<SavedRecording[]> {
  const recordings = await transact<SavedRecording[]>('readonly', store => store.getAll())
  return recordings.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveRecording(blob: Blob, name: string): Promise<SavedRecording> {
  const recording: SavedRecording = { id: crypto.randomUUID(), name, createdAt: Date.now(), size: blob.size, blob }
  await transact('readwrite', store => store.put(recording))
  return recording
}

export async function deleteRecording(id: string): Promise<void> {
  await transact('readwrite', store => store.delete(id))
}
