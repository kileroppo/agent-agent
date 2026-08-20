# @agent-army/ui-tokens

Shared CSS design tokens (custom properties) for all agent-army frontend apps.

## Entry

`tokens.css` - single CSS file defining `:root` custom properties.

## Usage

Tokens are distributed to each app's `public/` directory by running:

```sh
npm run distribute:tokens
```

This is automatically executed as part of `npm run check`.

Each app's `index.html` loads `/tokens.css` before its own `/styles.css`.

## Verification

```sh
npm run check
```

## Non-targets

- This package does NOT process, bundle, or transform CSS.
- It does NOT replace existing per-app variable definitions (apps retain their own `:root` overrides).
- It does NOT include component styles, only primitive design tokens.
