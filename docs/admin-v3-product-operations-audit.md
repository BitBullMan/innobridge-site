# Innobridge Admin V3 Product Operations Audit

## Classification

### Ready

- Registered user directory from `aml_user_profiles`.
- Daily Briefing subscription operations from `user_briefing_subscriptions`.
- Existing production delivery controls and jobs.
- Read-only access and entitlement view.
- Content inventory from `news`, `compliance_news_signals`, and `intelligence_objects`.
- Sanctions operations view through the existing `aml-api` Edge Function.
- Freeze Data dashboard, address operations, imports, staff access, and audit log.
- Dataset freshness based on observed production timestamps.

### Needs Data

- Visitors.
- Active and returning users.
- Product-action counts and funnels.
- Last-active timestamps derived from real product usage.
- Deterministic engagement scoring.

No product analytics event table currently exists. Account creation, admin events, and email delivery jobs are not substitutes for product behavior analytics.

### Needs Backend

- A first-party product event contract and ingestion endpoint.
- Aggregated daily analytics for acquisition, activation, retention, and product actions.
- A supported user activity timeline joining product events to authenticated users.
- Optional pipeline-run observability with explicit success, failure, duration, and error fields across all data products.

### Needs Decision

- Engagement score inputs and thresholds.
- Lifecycle definitions beyond the provisional account states `New`, `Activated`, and `Inactive`.
- Product plans and the entitlement matrix.
- Whether subscription status should affect sanctions access.
- Retention windows for product analytics and operational logs.

## Current Sanctions Access Model

### Current rule

Full sanctions results are returned to an authenticated, non-anonymous Supabase user who has an active `aml_user_profiles` record. Anonymous or inactive users receive the public preview.

Subscription status, admin status, and legacy law-enforcement status are not currently required for full sanctions access.

### Where enforced

1. The public dashboard obtains the Supabase session access token.
2. The dashboard sends the bearer token to `aml-api?action=sanctions_intelligence`.
3. The `aml-api` Edge Function validates the token with Supabase Auth.
4. The Edge Function reads `aml_user_profiles` and checks `is_active`.
5. The Edge Function uses its service-role database connection to return full or preview data.

The Admin V3 entitlement page is read-only and does not replace this backend authorization path.

### Dependencies

- `dashboard.html`
- `admin.html`
- Supabase Auth
- `aml_user_profiles`
- `sanctions_sources`
- `sanctions_designations`
- `sanctions_addresses`
- `aml-api` Edge Function
- Supabase anon key for client initialization
- Edge Function service-role secret

### Security risks

- The current sanctions rule grants full results to every active registered profile, independently of subscription or an explicit entitlement.
- `aml-api` is deployed with platform JWT verification disabled and therefore must continue to validate bearer tokens inside the function for protected actions.
- The public table `address_labels` currently has RLS disabled. No automatic remediation was applied because enabling RLS without an approved policy can break production reads. This should be handled as a separate reviewed database migration.

### Recommended migration options

- **A. Preserve registered-user access:** formalize the existing active-profile rule as an explicit entitlement and document it.
- **B. Subscription entitlement:** require an active plan or product entitlement in addition to an active profile.
- **C. Explicit grants:** introduce a backend `user_entitlements` model for sanctions, exports, alerts, and other products.

Any migration must remain backend-enforced and include RLS/Edge Function tests for anonymous, active, inactive, subscribed, non-subscribed, admin, and legacy LE users.

## Analytics Recommendation

Add a minimal first-party event stream only after event names, user identity rules, consent, retention, and reporting requirements are approved. Suggested initial events are `session_started`, `freeze_search`, `sanctions_search`, `record_opened`, `export_requested`, `watchlist_changed`, and `briefing_opened`. Until then, Admin shows explicit unavailable states rather than estimates.
