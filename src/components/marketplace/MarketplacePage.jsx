import { Coins, CreditCard, PlusSquare } from 'lucide-react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageHeader } from '../ui/PageHeader'
import { SubNavTabs } from '../ui/SubNavTabs'
import { SignalsMarketplacePage } from '../SignalsMarketplacePage'
import { BuyEntitlementPage } from './BuyEntitlementPage'

const MARKETPLACE_TABS = [
  { to: '/marketplace/bot-slot', label: 'Bot Slot', end: true },
  { to: '/marketplace/symbol-slot', label: 'Symbol Slot' },
  { to: '/marketplace/subscription', label: 'Subscription' },
  { to: '/marketplace/bot-signal', label: 'Bot Signal' },
]

// SaaS Phase 8F: the Marketplace's own top-level nav section (pulled out of Config per the
// redesign spec) - Bot Slot / Symbol Slot / Subscription are simple instant-buy pages sharing
// BuyEntitlementPage; Bot Signal is its own richer per-signal picker (SignalsMarketplacePage).
export function MarketplacePage({ settings, isAdmin, onBuyBotSlot, onBuySymbolSlot, onBuySubscription, buying }) {
  return (
    <div className="grid gap-6">
      <PageHeader title="Marketplace" description="Buy bot slots, symbol slots, a subscription, or individual bot signals - instant, no payment required during this test phase." />
      <SubNavTabs tabs={MARKETPLACE_TABS} />
      <Routes>
        <Route index element={<Navigate to="bot-slot" replace />} />
        <Route path="bot-slot" element={(
          <BuyEntitlementPage
            icon={PlusSquare}
            title="Buy a Bot Slot"
            description="Each bot slot adds an empty bot to your Dashboard. Open it in Bot Creation to fill it with a premade bot or build your own from signals."
            currentLabel="Bot Slots"
            currentValue={isAdmin ? 'Unlimited' : `${(settings.botSlotList || []).length} owned`}
            buyLabel="Buy 1 Bot Slot"
            purchaseNote="The new slot starts empty - pick a premade bot for it or combine your signals into a custom one. Claim your free bot from the Dashboard if you haven't yet."
            onBuy={onBuyBotSlot}
            buying={buying}
            isAdmin={isAdmin}
          />
        )} />
        <Route path="symbol-slot" element={(
          <BuyEntitlementPage
            icon={Coins}
            title="Buy a Symbol Slot"
            description="Each symbol slot lets you track one more trading pair in your bots' scan universe. New accounts start with 10."
            currentLabel="Symbol Slots"
            currentValue={isAdmin ? 'Unlimited (auto-managed)' : `${Number.isFinite(settings.symbolSlots) ? settings.symbolSlots : 10} owned`}
            buyLabel="Buy 5 Symbol Slots"
            purchaseNote="Pick which symbols to use on Settings > Automation once you have the slots."
            onBuy={onBuySymbolSlot}
            buying={buying}
            isAdmin={isAdmin}
            adminNote="The admin account stays on the auto-managed top-60-by-volatility universe."
          />
        )} />
        <Route path="subscription" element={(
          <BuyEntitlementPage
            icon={CreditCard}
            title="Buy a Subscription"
            description="A baseline account subscription. No real billing yet during this test phase - this just marks your account as subscribed."
            currentLabel="Subscription"
            currentValue={isAdmin ? 'N/A' : (settings.subscriptionTier ? 'Baseline (active)' : 'None')}
            buyLabel="Buy Baseline Subscription"
            onBuy={onBuySubscription}
            buying={buying}
            isAdmin={isAdmin}
          />
        )} />
        <Route path="bot-signal" element={<SignalsMarketplacePage />} />
        <Route path="*" element={<Navigate to="/marketplace/bot-slot" replace />} />
      </Routes>
    </div>
  )
}
