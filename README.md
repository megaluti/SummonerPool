# Riftbound Shared Pool

A static React + TypeScript + Vite application for sharing a Riftbound TCG card pool. GitHub Pages hosts only the client; Supabase Auth and Postgres are the authoritative identity/database. The browser stores Supabase's auth session and app preferences only, not pool data.

## MVP behavior

- Email/password sign-up and sign-in through Supabase Auth.
- Create pools, invite a specific email using a one-time invitation ID, and accept the invitation after signing in with that same email. Pool creators are admins; invited users are members. Admins may invite. Members can register cards, create/edit/archive decks, allocate cards, transfer ownership, and request/confirm physical loans. Membership checks and writes are enforced by RLS and database functions.
- Search Riftcodex card names, inspect card images and metadata, and register bulk quantities as distinct physical copy rows.
- Each copy has independent `owner_id`, `holder_id`, and optional `deck_id` state. Ownership transfer does not move the card; a loan request does not change the holder until the recipient confirms it, and a return is completed only when the owner confirms it.
- Deck requests store a requested quantity; individual copies are allocated to active decks. Postgres locks the copy and requested-card row in a transaction so duplicate copy reservations and concurrent over-allocation fail. No deck size, card limit, format, or construction rules are assumed.
- Filter inventory by name/set/collector number, owner, physical holder, allocation status, and deck. The activity view shows the audit trail.

## Setup

1. Create a Supabase project. In **Authentication → Providers**, enable Email. Configure the site's URL and redirect URLs to include the GitHub Pages URL (for example, `https://OWNER.github.io/REPOSITORY/`) and local development (`http://localhost:5173/`). The app uses hash routing so GitHub Pages does not need server-side route rewrites.
2. Apply `supabase/migrations/202610080001_shared_pool.sql` to the project using the SQL Editor, or install the Supabase CLI and run:

   ```sh
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

3. Copy `.env.example` to `.env.local` and provide the **project URL** and **anon/publishable key**:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
   ```

   Never put a Supabase service-role key in a `VITE_*` variable or in this repository. The client uses the anon key; row-level security is the security boundary.
4. Install and run:

   ```sh
   npm ci
   npm run dev
   ```

5. Configure GitHub repository **Settings → Pages → Build and deployment → GitHub Actions**. Add Actions secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The workflow in `.github/workflows/deploy.yml` builds with the repository subpath as Vite's base, runs unit tests, then publishes `dist/`. Push to `main` or run the workflow manually. If your default branch is not `main`, edit the workflow trigger. Set the deployed site URL in Supabase Auth settings.

## Riftcodex card search and CORS

Riftcodex's public API docs are at [riftcodex.com/docs](https://riftcodex.com/docs) and its OpenAPI document is [api.riftcodex.com/openapi.json](https://api.riftcodex.com/openapi.json). The published schema documents:

- `GET https://api.riftcodex.com/cards/name?fuzzy=...` (and `exact=...`), returning a paginated object with an `items` array.
- `GET https://api.riftcodex.com/cards/{id}` for card details.
- Card fields including `id`, `name`, `set.set_id`, `set.label`, `classification.rarity`, and `media.image_url`. The UI uses only the documented fuzzy name endpoint and fields.

The API docs do not specify CORS. A browser preflight probe during development was intercepted by Cloudflare, so this project does not claim that direct browser fetches are supported. It attempts direct access by default and surfaces a setup error if the browser blocks it.

For reliable browser access, deploy the included **external** Supabase Edge Function proxy (not GitHub Pages):

```sh
supabase functions deploy riftcodex-proxy --no-verify-jwt
```

The function allows only GET/OPTIONS and a bounded fuzzy-name search; it calls the documented Riftcodex endpoint server-side, validates the `items` response, sets permissive CORS for public card data, and uses no secrets. Add the resulting URL as the GitHub Actions secret `VITE_RIFTCODEX_PROXY_URL`, and as a local `.env.local` setting for development:

```dotenv
VITE_RIFTCODEX_PROXY_URL=https://YOUR_PROJECT.supabase.co/functions/v1/riftcodex-proxy
```

The proxy is intentionally public and read-only: it contains no privileged Supabase credentials and does not access pool data.

## Database security and data model

The migration enables RLS on every user-facing table. Pool membership and admin checks are database functions, not UI-only checks. Writes to physical copies and loans go through authenticated Postgres functions that validate current membership and row state; no copy write grants are given to the browser. Invitation claiming checks the authenticated JWT email, expiration, and single-use state. Foreign keys ensure owners, holders, and decks belong to the same pool. Each copy row represents one physical card, while `deck_requests` records requested quantities.

The `allocate_copy` function locks the copy row and its matching deck request, then checks active deck membership, matching card ID, and remaining requested count before changing `deck_id`; the operation is atomic. Concurrent attempts serialize on those locks. A separate database trigger prevents reducing a request below copies already allocated. The `copies_audit_*` and `loan_requests_audit` triggers persist lifecycle changes.

## Tests

Run the local card adapter tests and TypeScript production build:

```sh
npm test
npm run build
```

The database integration test creates temporary users and a temporary pool, and exercises separate authenticated clients (cross-device persistence), non-member RLS/RPC rejection, concurrent duplicate-copy allocation, concurrent requested-quantity allocation, independent owner/holder updates, and confirmed loan handover/return. It uses the service-role key only in a local test process for temporary account setup/cleanup; never configure that key in GitHub Pages or the app:

```sh
SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY \
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY \
npm run test:integration
```

Use a disposable Supabase project with the migration applied. The script deletes the test pool and temporary accounts in a `finally` block.

## Scope and assumptions

- The pool's owner is its initial admin. Invitations add members only; this MVP has no admin-promotion workflow, expiring invite email delivery, password reset UI, or multi-factor settings. Admins share an invitation ID with the intended email recipient using their normal communication channel.
- Every pool member can collaborate on inventory and decks; members cannot add other members or create invitations. Admin authority is limited to invitations and the admin-only database actions documented above.
- Ownership transfers are explicit but do not require the recipient to approve them. Physical handovers and returns require recipient/owner confirmation respectively. Pool membership cannot be removed from a member while copies or active loans reference them.
- Riftcodex is an external dependency and may rate-limit or change its API. Its current OpenAPI docs describe data used by the card adapter; upstream outages are displayed as errors and are never replaced with sample/mock data.
- Browser storage may be used internally by Supabase Auth for the signed-in session. Collection data is fetched from Supabase and is not mirrored into local storage.
