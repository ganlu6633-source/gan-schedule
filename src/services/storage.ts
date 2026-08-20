import { AppState } from '../types';
import { seedState } from '../data/seed';

const STORAGE_KEY = 'ganschedule_app_state_v1';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

let memoryCache: AppState | null = null;

export function loadState(): AppState {
  if (memoryCache) {
    return clone(memoryCache);
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    memoryCache = clone(seedState());
    return clone(memoryCache);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      memoryCache = clone(JSON.parse(raw) as AppState);
      if (!Array.isArray(memoryCache.pendingSubmissions)) {
        memoryCache.pendingSubmissions = [];
      }
      return clone(memoryCache);
    }
  } catch {
    // ignore read error
  }
  memoryCache = clone(seedState());
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache));
  return clone(memoryCache);
}

export function saveState(next: AppState) {
  const cloned = clone(next);
  memoryCache = cloned;
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cloned));
  }
}

export function resetState() {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  memoryCache = clone(seedState());
  saveState(memoryCache);
}
