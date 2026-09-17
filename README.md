# NewReward Pricing Calculator

Static, browser-based pricing and proposal calculator for New Reward SEO + AEO/GEO and managed Google + Meta ads programs.

## Source of truth

- `index.html` is the deployed application.
- `newreward-pricing-calculator.html` is a compatibility mirror and must remain byte-identical to `index.html`.
- `harness.js` covers paid-media math and browser-level regression scenarios.

## Input policy

- SEO and AEO/GEO visibility scores come from New Reward's internal audit and are used exactly as entered.
- Client economics are reviewed with the prospect before a proposal is finalized.
- Blank economics use the calculator's visible industry benchmark; researched or client-confirmed values override it.
- Footprint is based on actual service reach. B2B is not automatically non-geographic.

## Verification

Run the pure regression suite:

```sh
node harness.js
```

For the full browser suite, install Playwright locally and run:

```sh
node harness.js --live
```
