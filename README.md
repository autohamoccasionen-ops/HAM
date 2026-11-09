# HAM Offerten-Dienst

Server-side calculation and read-only D-Store / HaynesPro integration for a
Motoröl-Service. The original website is a separate application.

## Deployment and verification

Enable automatic quotations only after a complete hosted supplier lookup has
been verified for the supported scope. A healthy `/healthz` response confirms
the HTTP process alone. The authenticated status endpoint reports whether this
process has completed a quotation and the timestamp of its latest success.
Thirty-eight automated tests cover calculations, HTTP behavior and consent
safeguards; they do not prove ongoing supplier availability. Never publish real
vehicle data, credentials or private operational diagnostics in this repository.

Hosted checks also cover Motoröl-Service with front-axle discs and pads,
and Motoröl-Service with a fuel filter plus the brake-fluid and climate-
disinfection packages. Itemized prices and VAT-inclusive cart totals matched.
These checks do not certify every vehicle or every additional service.

## Runtime configuration

Set these values in Render's **Environment** settings:

- `DSTORE_USERNAME`: existing D-Store username.
- `DSTORE_PASSWORD`: existing D-Store password (never share it in chat).
- `QUOTE_SERVICE_TOKEN`: server-to-server bearer secret, at least 32 characters.
- `QUOTE_AUTOMATION_ENABLED`: defaults to `false`; set to `true` only for a
  verified supported integration after credentials have been configured.

Keep the token and credentials out of frontend JavaScript, source control,
browser storage, request URLs and logs. The website will need a server-side
proxy; do not call this API with the secret directly from browser code.

## API

- `GET /healthz`: public HTTP health, no vendor request or configuration values.
- `GET /api/status`: bearer-protected configuration and enablement status.
- `POST /api/quotes`: synchronous bearer-protected JSON: `vin` (17 characters), `mileage`
  (integer), `service` (`oel-service`) and `extras` (selected package names or an empty array).
- `POST /api/quote-jobs`: same input; immediately returns a pending job identifier.
- `GET /api/quote-jobs/{jobId}`: bearer-protected polling; returns 202 while
  pending, then the complete quotation or manual review. Jobs are in memory,
  expire after ten minutes and are lost on restart. No customer records are
  written to disk. Use short polling requests for website integration.
- Quote results include itemized materials, list prices excluding VAT, labour
  at CHF 150/h, VAT 8.1% and a total rounded upward to CHF 0.05.
- Failures return `status: manual-review` with an error code and no invented price.

## Current integration limits

- Supplier page changes, login challenges and ambiguous data cause manual review;
  a past successful lookup does not guarantee future availability.
- Motoröl-Service supports garage package prices and guarded lookups for
  front/rear brake pads, brake discs with pads, filters, starter batteries,
  spark plugs, belts and wipers. Each requires its own complete parts and labour evidence.
  The presence of an adapter is not proof of end-to-end supplier verification.
  Unpriced, ambiguous, unlisted or incomplete selections require manual review.
  An explicit supplier no-parts result is also manual review; it never means
  that a different vehicle's part may be substituted. Distinct cabin-filter
  installation positions are not interchangeable alternatives.
  This is not an all-services / all-VIN release.
- Package amounts include their labour. They are itemized once, with VAT and
  cash rounding applied only after the complete net subtotal is calculated.
- Conflicting selections and dependent options without their required service
  are rejected. Request and quotation selections must match.
- Initial oil mapping: Castrol 0W-20 C5 SKU 15F6E6, only when HaynesPro explicitly
  lists MB 229.71 / SAE 0W-20 for the resolved vehicle and the current product
  page confirms that approval and the 1-litre package. Other explicit manufacturer
  approvals use a guarded catalogue search requiring the same approval, viscosity,
  one-litre packaging and current retail price. This fallback still requires
  end-to-end verification on additional vehicle specifications; no oil is universal.
- Filter and drain-plug selections require a VIN badge and a listed seal.
  Packaging multiples and unpriced items are rejected.
- Each lookup starts a new, in-memory browser context. No session files,
  screenshots, traces, invoices, customer records or parts orders are saved.
- One lookup at a time; busy requests return 429. A 420-second lookup deadline
  closes the context. No CAPTCHA solving, fingerprint changes or proxy routing.
- Do not automatically retry VIN lookups or place anything in the parts cart.

## Validation

Run `npm test` for pure parsing/calculation and HTTP contract tests. These tests
do not start a browser or access any supplier account. Perform a separate real hosted
end-to-end test before enabling a new vehicle specification or website flow.

Use the same pinned version of Playwright for npm and the official Docker image.

