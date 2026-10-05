# Figma Grab

Paste a Figma link → get every screen as a card (screenshot + "Open in Figma" link). Everything is also saved to
`~/Documents/Figma Grab/<file>__<page>/` (`renders/`, `nodes/` full JSON, `nodes-slim/`, `assets/`, `index.json`).

## Use
1. Open **Figma Grab.app**. First run: paste a Figma personal access token (File content → Read). It's stored encrypted in the macOS Keychain.
2. Paste a link to a page, section or frame (right-click → *Copy link to selection*) and press **Start**.

## Develop (needs Node ≥ 22.12 to build)
```
npm install
npm start          # run in dev
npm test           # offline end-to-end test of the engine (fake Figma API; needs ~/stock-comparison fixture)
npm run pack       # builds dist/Figma Grab-darwin-arm64/Figma Grab.app (Apple Silicon, ad-hoc signed)
```
Layout: `src/core.js` engine · `src/main.js` Electron main · `src/preload.js` bridge · `src/thumbs.js` previews · `src/renderer/` UI.
