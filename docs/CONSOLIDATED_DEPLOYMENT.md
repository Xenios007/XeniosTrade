# Consolidated bot deployment — 2026-09-13

Deployed to `/home/xenios/app` on `139.180.209.238`, preserving the newer server baseline `c0b9064`. Page: `https://projxenios.trade/consolidated-bot` (normal application login required).

- Isolated server staging: 68 tests passed; production Vite build passed. Warnings: existing large bundle and outdated Browserslist data.
- Targeted baseline hashes verified before replacement. Backup: `/home/xenios/app-backups/consolidated-20260913/original.tgz`; original server agent log alongside it.
- Published frontend to both app `dist/` and `/var/www/xeniostrade/`. Used recursive copy without directory ownership/timestamp changes because the web root belongs to www-data. Old hashed assets retained for recovery.
- Restarted existing PM2 `xeniostrade-api`, PID 1032272, restart count 13 at verification.
- Authenticated API, testnet credential check, and live signal scan passed. 32 source signals, zero accepted candidates, zero scan errors at activation.
- Actual testnet entries ENABLED via authenticated control. No consolidated position, pending order, or completed trade at activation. This verifies readiness and activation, not a completed exchange execution. No arbitrary trade was forced.
- Five pre-existing exchange positions remained unchanged at verification: BCHUSDT, ALICEUSDT, LTCUSDT, OGUSDT, API3USDT. Testnet available balance 687.99400955 USDT.
- Model fingerprint: `6d9cfc8ea5d53280b6dc8c80ccd132d92042071079b2d822264ef9a7dd8636a6`.
- Settings/recovery files and original bot allocations were not edited. Local runtime ledgers were not uploaded. No real-money execution enabled.

Use the consolidated page to pause testnet entries and inspect its separate exchange ledger. Enabled testnet state persists across restart; paper mode remains independently paused. Keep the API running to reconcile positions even when entries are paused. Before rollback, pause entries and reconcile any consolidated pending/open exposure; never restore code blindly while it owns an exchange position. Review `CONSOLIDATED_BOT.md` for risk limits and emergency-failure behavior.

The strategy is research-only: holdout profit factor 0.745, with negative expectancy. Testnet orders test implementation and forward behavior; they do not establish a profitable edge.
