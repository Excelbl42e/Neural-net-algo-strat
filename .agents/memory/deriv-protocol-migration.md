---
name: Deriv protocol migration
description: Evidence and caution for diagnosing legacy versus current Deriv WebSocket access.
---

The legacy WebSocket endpoint returned HTTP 520 on 2026-09-28 from this workspace, both with and without Origin. The current public Options WebSocket completed a 101 upgrade and returned ping, real tick, and candle frames without credentials. A custom app ID was not available for comparison; no account authorization was attempted. Do not attribute the 520 specifically to Origin, shared app ID, or the app's request schema from this evidence alone.

**Why:** Deriv's current API documents separate unauthenticated public data and OTP-authenticated account WebSockets, whereas this project's legacy client uses a shared app ID and an `authorize` frame. A working public channel does not demonstrate broker authorization.

**How to apply:** Compare with Deriv's current [API overview](https://developers.deriv.com/docs/intro/api-overview/), [authentication](https://developers.deriv.com/docs/intro/authentication/), and [Options WebSocket OTP flow](https://developers.deriv.com/docs/options/websocket/) before changing account/trade behavior. Keep public-feed evidence separate from any credential-backed broker evidence, and never log OTP URLs or tokens.