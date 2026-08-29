import { useEffect, useState } from 'react'

const STORAGE_PREFIX = 'xeniostrade.ui.'

function readStoredBoolean(storageKey, fallbackValue) {
  if (!storageKey || typeof window === 'undefined') {
    return fallbackValue
  }

  try {
    const rawValue = window.localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`)
    if (rawValue == null) {
      return fallbackValue
    }

    if (rawValue === 'true' || rawValue === 'false') {
      return rawValue === 'true'
    }

    const parsedValue = JSON.parse(rawValue)
    return typeof parsedValue === 'boolean' ? parsedValue : fallbackValue
  } catch {
    return fallbackValue
  }
}

export function usePersistentBoolean(storageKey, fallbackValue = false) {
  const [value, setValue] = useState(() => readStoredBoolean(storageKey, fallbackValue))

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(value))
    } catch {
      // Ignore storage failures so the UI still works normally.
    }
  }, [storageKey, value])

  return [value, setValue]
}
