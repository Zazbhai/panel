# Dashboard interface

This is a task-focused operations panel. The visual reference is the local `design/` directory: warm light surfaces, compact tables, neutral borders and restrained terracotta actions.

Use one system font, sentence-case labels and short instructions. Primary buttons perform the main save or send action; refresh, edit and navigation use secondary buttons or links. Destructive actions use red and name the affected item in a confirmation dialog. Service switches are native checkbox inputs with switch semantics; selected sections remain checkboxes.

Forms use visible labels, inline validation and clear keyboard focus. Dialogs use native `<dialog>` focus management, Escape cancellation and explicit action labels. Long content wraps; wide tables scroll within the panel. Navigation collapses below 900px and uses a real menu button.

Shared styles and interactions live in `frontend/dashboard.css` and `frontend/dashboard-ui.js`. Run `node scripts/build-frontend.cjs` after editing these files. The build embeds them in all seven HTML pages so no backend asset route is needed. Page-specific API and business logic stays in the existing scripts.

The devices page follows `design/photo_11_2026-11-17_19-39-25.jpg`: compact device cards with online/offline status, battery, last seen and reported phone numbers. Its database selector reads saved rotation URLs, and its device list includes both registered devices and client records. Search and All/Online/Offline filters apply before showing six matching cards; Show more reveals six additional cards. Status-tinted top borders distinguish the cards, with restrained hover and focus effects. Message details load on demand. There are no date filters. Page-only styles live in `frontend/active-devices.css`; rebuild just this page with `node scripts/build-frontend.cjs active-devices`.

The existing collection API has no server pagination. Six-card batches limit DOM work, but the first load still reads both complete sections. Background polling reads only client status every 30 seconds, reusing registered details from the last successful load. Refresh and database changes read both sections. Showing more and changing filters make no collection requests. True six-record network pages require a backend API change.

Verify changes using synthetic fixtures with all network requests intercepted. Do not launch the production backend or access Firebase for visual verification.

Service messages use bordered cards, a local search field, a service selector, copy feedback and a keyboard-accessible auto-refresh switch. Only new cards animate; retained cards keep their focus and position during five-second polling. Reduced-motion preferences disable movement. Twelve messages render initially; Show more reveals the next twelve from the loaded results. Page-only styles live in `frontend/service-messages.css`.

The service-messages build embeds the exact contents of `service-matching.js` before the page controller, avoiding a separate asset dependency on older running servers. Matching rules remain in that source file. Run `node scripts/build-frontend.cjs service-messages` after editing it or this page's styles, then `python scripts/verify-service-messages.py` for isolated regression checks, including an unavailable standalone matching asset.

Recent Orders uses responsive cards with six visible orders per batch, lazy order-message disclosure, status/search filters, and All dates, Today, Yesterday, This week, This month, and custom inclusive date ranges. The API remains unchanged and filtering is applied to the loaded recent-order response. Page-only styles live in `frontend/recent-orders.css`; use `node scripts/build-frontend.cjs recent-orders` and `python scripts/verify-orders-services.py` for focused checks.

Services uses a compact editor with one bounded template row per sample, inline Match switches, icon-only remove controls, and collapsed template previews in configured-service cards. The existing service payload and save behavior remain unchanged. Page-only styles live in `frontend/services.css`; the focused checks also exercise multiple templates at mobile widths.

Order OTP completion is service-scoped on the server. An active order now reads its configured service by name and accepts a code only when the complete message matches an enabled template, OTP length range, and sender filter. A generic OTP or another service's message leaves the order waiting. The browser and server matching implementations are intentionally covered by separate regression checks; do not restore the old keyword-only scan in `server.js`.
