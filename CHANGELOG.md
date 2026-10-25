# Changelog

What changed for the user in each release. The full text of each release, in English and
Russian, is on the [releases page](https://github.com/ALEXalesha/LiquidGlass/releases).

## 1.1.0 - 2026-09-25 - The window opens where it was closed, at the same size

The place, size and maximized state go to `window-state.json` in the app's data folder after a move or resize and on close, and come back at the next start. What was saved is checked against today's monitors: if that monitor is gone the window opens in the middle of the main one, if it is larger than the screen it is shrunk, and the tab bar is always on a screen. The module is the same one the calculators, Paint Pro, SyncGlass and Translator AI use.

32 shell tests green.

## 1.0.0 - 2026-09-22

The five pages packed into one window with a tab bar - no browser, no server, no network.

**Try it without downloading anything:** [alexalesha.github.io/LiquidGlass](https://alexalesha.github.io/LiquidGlass/)

**What is inside the app**

Nothing leaves the machine: the content policy allows no network source at all, and the self-check verifies both that nothing the pages need was refused and that no request left the machine.
