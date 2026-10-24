# slug-consumer

`src/` is native ES modules (`"type": "module"`): named exports, no CommonJS.
`legacy/` holds pre-2019 CommonJS helpers being retired; `src/index.js` re-exports
`slugify` from `src/utils/slugify.js`, which does not exist yet.
