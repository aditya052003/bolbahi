# BolBahi

BolBahi is a voice-first order pad for an Indian kirana counter. It records a short order, sends converted audio to Gnani speech-to-text, shows the returned transcript, parses a deliberately limited catalogue, and requires a completed Gnani read-back plus a confirmation click before writing a receipt to local order history.

## Start locally

Use Node.js 20 or newer. On Windows PowerShell, use `npm.cmd` if the `npm` command is blocked.

```powershell
npm.cmd install
```

The existing `.env` is read by the Express backend and should not be overwritten. If this folder has no `.env`, copy `.env.example` to `.env`, then add your Gnani API key to the backend variable `GNANI_API_KEY`. Do not put the key in frontend files or browser settings. Restart the server after changing it.

```powershell
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). The single `dev` command starts Vite and Express together. Vite proxies `/api` requests to the backend on port 3001. Microphone access requires localhost or HTTPS.

If your PowerShell policy permits `npm`, the equivalent commands are `npm install` and `npm run dev`.

## Speech integration

The app uses Gnani’s Speech APIs directly. It does not use Agent Builder. The current integration uses these documented REST requests:

| Task | Endpoint and model | Authentication and response |
| --- | --- | --- |
| Speech-to-text | `POST https://api.vachana.ai/stt/v3`, form field `model=prisma-v3.0` | Backend sends `X-API-Key-ID` and multipart `audio_file`, `language_code=indic-auto`, `format=codemix`, and catalogue terms. Gnani returns JSON with `success`, `transcript`, `model`, and detected language. |
| Text-to-speech | `POST https://api.vachana.ai/api/v1/tts/inference`, `model=timbre-v2.5`, `voice=Poorvi`, `language=hi-en` | Backend sends `X-API-Key-ID` and JSON. The request asks for mono, 48 kHz, 16-bit PCM WAV; Gnani returns binary audio. |

Gnani documents the STT REST formats as WAV, MP3, OGG, FLAC, AAC, and M4A, with a 30 second clip limit. Browsers commonly record WebM/Opus, so BolBahi decodes the browser recording and converts it to mono, 16 kHz PCM WAV in the browser before upload. The interface stops recording at 25 seconds; Express enforces 30 seconds, 8 MB, mono, 16-bit PCM, and 8–44.1 kHz. Raw audio is held in memory only for the request and is not written to disk.

The API key is loaded by Express from the backend environment only. It is never returned to the browser or written to logs. The frontend reports when Gnani speech is not configured and does not create placeholder transcripts or audio. STT/TTS calls are made once per user action; there are no automatic credit-consuming retries.

Official Gnani references: [REST transcription](https://docs.gnani.ai/api/STT/speech-to-text), [Prisma v3.0](https://docs.gnani.ai/api/STT/models/prisma-v3), [TTS REST inference](https://docs.gnani.ai/api/TTS/tts-inference), [available voices](https://docs.gnani.ai/api/TTS/available-voices), and [audio limits](https://docs.gnani.ai/api/STT/limits).

## Supported order language

The parser is deterministic and intentionally limited. It does not claim to understand unrestricted Hindi or Hinglish. Supported catalogue words are:

| Product | Example Hindi / Roman names |
| --- | --- |
| Rice | चावल, chawal, rice |
| Atta | आटा, atta, aata |
| Sugar | चीनी, chini, cheeni, sugar, शक्कर |
| Cooking oil | तेल, tel, oil |
| Milk | दूध, doodh, milk |
| Dal | दाल, dal, daal |
| Salt | नमक, namak, salt |
| Biscuits | बिस्किट, बिस्कुट, biscuit(s) |

Quantities support digits and a limited set of words from zero to ten, including `ek`, `do`, `teen`, `चार` / `chaar`, plus `aadha` / `आधा` (0.5), `dedh` / `डेढ़` (1.5), and `dhai` / `ढाई` (2.5). The supported units are kg/gram for rice, atta, sugar, dal, and salt; litre/ml for oil and milk; and packet for biscuits. Gram and ml values are normalized to the catalogue’s kg/litre unit.

In the spoken-correction flow, `kar do` / `कर दो`, `set`, and `change to` mean **set** that product to the stated quantity. `aur jod do` / `और जोड़ दो`, `add`, and `add more` mean **add** the stated quantity to what is already in the order. For example, “chawal chaar kilo kar do” sets rice to 4 kg, while “do kilo chawal aur jod do” adds 2 kg. If a correction has no clear set or add instruction, BolBahi leaves the current line unchanged and asks for clarification. Correction markers such as `nahi`, `nahin`, `नहीं`, `actually`, and `correction` introduce the following correction clause; they do not retroactively change the preceding item. A valid set also clears that same product’s earlier missing-quantity or missing-unit warning. Removal phrases include `hata do`, `hatao`, `nikaal`, `remove`, `cancel`, `mat dena`, and `मत देना`. For example, “Do kilo chawal aur ek litre tel. Nahi, chawal teen kilo kar do” produces rice 3 kg and oil 1 litre; the rice quantities are not added together. Quantities stated in grams/ml convert to the item’s catalogue kg/litre unit before the operation is applied.

If the parser cannot identify a product or unit, sees an unsupported phrase, or finds a missing or ambiguous quantity, it shows a clarification/review state. The shopkeeper can edit quantities and units, add a catalogue item, apply another spoken correction, and mark reviewed phrases. An order with incomplete item fields or unreviewed flags cannot be read back or saved.

Prices are fixed **demo prices**, shown in the interface and on receipts. All price calculations and saved totals use integer paise with per-line rounding. Customer identity is the synthetic walk-in label `Walk-in #104`; no customer phone number or real personal data is requested.

## Solo contribution

This is a solo project led by one contributor. The contributor supplied the product scope, shop-counter workflow, design direction, parser rules, and bug reproductions. Codex was used as an AI coding assistant for implementation, test authoring, and documentation. No other human contributors are represented in this workspace.

## Storage and confirmation

The Express backend writes confirmed order details to `server/data/orders.json` on the machine running the app server; the browser does not store orders in browser-local storage. In local development this is the same machine as the browser. The saved records include the synthetic customer label, receipt data, item lines, integer-paise totals, and the confirmation token used to prevent duplicate saves. They do not include raw audio. The generated `server/data/` directory is excluded by `.gitignore`. A read-back token is issued only after a successful Gnani TTS response and is bound to the exact item quantities and units. The save endpoint also requires `confirmed: true`; the UI only enables its confirmation button after audio playback finishes. Reusing the same confirmation token returns the saved order instead of creating a duplicate.

## Verification record

### Automated checks

```powershell
npm.cmd test
npm.cmd run build
```

The latest automated run passed all 18 tests and the production build. Tests cover correction replacement and addition, removals, Roman and Devanagari quantities, `aadha` and `dedh`, missing and ambiguous order details, integer-paise totals, confirmation/read-back requirements, local persistence, and duplicate-save protection. These automated checks do not exercise browser microphone permissions or prove live Gnani API access.

### Manual browser observations

The following observations were reported by the user after the parser fixes. They were not run or independently verified by Codex:

- A spoken rice correction produced rice 4 kg plus oil 1 litre, with an order total of ₹405.
- The confirmed ₹405 order appeared in receipts and order history.
- “Do packet” showed a missing-product warning and did not guess an item.
- Adding two packets of biscuits produced ₹20 at the current demo price.
- The user clicked **Mark reviewed** manually; clarification/review is not automatic.
- Audio playback correctness has not been explicitly confirmed.

These are manual browser observations, separate from the automated suite. The deterministic parser has bounded catalogue coverage and should not be treated as comprehensive Hindi/Hinglish understanding.

### Optional live-provider smoke test

The smoke test is separate from the automated suite:

```powershell
npm.cmd run smoke
```

If `GNANI_API_KEY` is unavailable, the smoke test reports that it was skipped. When configured, it makes one Timbre TTS request to produce a short spoken sample and one Prisma STT request to transcribe that audio; this consumes provider usage/credits. It prints only the outcome and model names, not the key or transcript. A smoke-test attempt in this workspace did not verify successful provider responses. Build/tests do not verify microphone behavior or live credentials.

## Available deployment setup

No hosting provider, Docker image, CI deployment workflow, or publishing configuration is included. Local production serving is available through the Express static-file path after building:

```powershell
npm.cmd run build
$env:NODE_ENV = "production"
npm.cmd start
```

Express serves `dist/` on `PORT` (default `3001`) and reads `GNANI_API_KEY` from the backend environment. This documents the available local production mode; the application has not been deployed or published.

