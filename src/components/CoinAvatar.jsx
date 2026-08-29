import { useEffect, useMemo, useState } from 'react'
import { getCoinFallbackTone, getCoinIconUrl, getCoinMonogram, normalizeCoinAsset } from '../lib/coinIcons'

const SIZE_CLASS_MAP = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
}

export function CoinAvatar({ symbol, size = 'sm', className = '' }) {
  const [showFallback, setShowFallback] = useState(false)
  const asset = useMemo(() => normalizeCoinAsset(symbol), [symbol])
  const iconUrl = useMemo(() => getCoinIconUrl(asset), [asset])
  const monogram = useMemo(() => getCoinMonogram(asset), [asset])
  const fallbackTone = useMemo(() => getCoinFallbackTone(asset), [asset])
  const sizeClass = SIZE_CLASS_MAP[size] || SIZE_CLASS_MAP.sm

  useEffect(() => {
    setShowFallback(false)
  }, [asset])

  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-white/10 ${sizeClass} ${className}`}>
      {iconUrl && !showFallback ? (
        <img
          src={iconUrl}
          alt={`${asset || 'Coin'} icon`}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setShowFallback(true)}
        />
      ) : (
        <span className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${fallbackTone} font-semibold uppercase text-white`}>
          {monogram}
        </span>
      )}
    </span>
  )
}
