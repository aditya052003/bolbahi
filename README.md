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

## Verification record

### Automated checks

Run the automated suite and frontend production build with:

       npm.cmd test
       npm.cmd run build

The latest automated run passed all 25 tests and the production Vite build. In addition to parser, quantity, clarification, correction, removal, paise-total, confirmation, local-persistence, and missing Gnani configuration coverage, tests exercise DynamoDB conditional-save/history behavior and the Lambda bridge handling base64 multipart audio and binary WAV responses. AWS SDK calls are represented by a fake client in automated tests; these checks do not call live AWS or Gnani.

### User-reported browser observations

These observations were reported by the user after the parser fixes; they were not run or independently verified by Codex:

- A spoken rice correction produced rice 4 kg plus oil 1 litre, total ₹405.
- The confirmed ₹405 order appeared in receipts and history.
- “Do packet” produced a missing-product warning without a guessed item.
- Adding two packets of biscuits produced ₹20 at the demo price.
- The user clicked Mark reviewed manually; clarification was not automatically resolved.
- Audio playback correctness has not been explicitly confirmed.

### Optional live Gnani smoke test

The optional command is `npm.cmd run smoke`. When configured, it calls Timbre TTS and Prisma STT once each and may consume provider credits. It does not print the key or transcript. The smoke command was attempted once during this preparation, but the initial Timbre TTS request stopped with `EACCES` before receiving a provider response; Prisma STT was not attempted. No successful live Gnani response has been verified.
## Storage and confirmation

In local development, Express saves confirmed order details to data/orders.json on the machine running the app. The generated data/ directory is excluded from Git. In AWS, the SAM Lambda uses DynamoDB; the table is keyed by the read-back confirmation token, and a conditional write prevents duplicate receipts. A created-time index powers the latest 100 history entries. Point-in-time recovery is disabled for this demo, and the table is retained if the stack is removed. This workspace's existing local JSON history was moved byte-for-byte from the legacy server/data/orders.json path into ignored data/orders.json. Other legacy installations must move their file there before changing versions; that migration is not automatic.

Both storage paths keep the synthetic customer label, receipt data, catalogue item lines, integer-paise totals, and the confirmation token. Neither path stores raw audio. The browser fetches order history through the Express API; it does not use browser local storage. The UI requires a successful Gnani TTS response, completed playback, and an explicit confirmation click before saving. Changing the order invalidates the previous read-back token.

## AWS deployment setup

The repository includes amplify.yml for the React/Vite frontend and template.yaml for the Express API on Lambda behind an API Gateway HTTP API, plus a DynamoDB orders table. Nothing has been deployed. The Amplify build publishes dist/ and reads only the public API URL from VITE_API_BASE_URL; the Gnani credential is never a Vite variable. The frontend uses relative /api requests locally through the Vite proxy and uses the configured base URL in Amplify.

### Required AWS settings

- Use an AWS account/region with AWS CLI, AWS SAM CLI, and Node.js 20 or newer available. Root npm dependencies are used for local development; SAM installs the pinned backend dependencies from `server/package.json` and `server/package-lock.json` when it builds the Lambda artifact.
- After deployment, set `GNANI_API_KEY` privately in the Lambda console under **Configuration → Environment variables → Edit** for `BolBahiApiFunction`. Lambda exposes the value to the backend as `process.env.GNANI_API_KEY`; it is intentionally absent from the SAM template and deployment parameters. AWS encrypts Lambda environment variables at rest. Restrict access to the Lambda configuration to trusted operators. After every SAM deployment or function configuration update, verify the variable is still present before using speech; template updates can replace console-edited environment settings. See [Lambda environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).
- Create or connect the Amplify Hosting app first so its branch HTTPS origin is known. The CORS parameter must be the exact origin, without a trailing slash or path. Local Vite origin is allowed separately for development.
- The Lambda uses the nodejs22.x runtime and its runtime-provided AWS SDK for JavaScript v3 to access DynamoDB. Its role can only GetItem and PutItem on the table and Query on the history index. It cannot scan the table.
- The public API currently has no shopkeeper sign-in or authorization. CORS controls browser origins but is not authentication. Add an identity/authorization layer and abuse controls before using it for real customer orders or provider-credit-bearing traffic.

### Build and deploy when ready

1. From the repository root, install the frontend dependencies and run the checks. SAM uses the separately pinned backend dependency lockfile:

       npm.cmd ci
       npm.cmd test
       npm.cmd run build
       sam validate --lint
       sam build

   `sam build` uses `server/package.json`, `server/package-lock.json`, and esbuild to create the Lambda artifact. The SAM `CodeUri` is the `server/` folder, so the project-root `.env` file and local `data/` order history are outside the Lambda deployment package.

2. Deploy the backend when AWS resources are approved. Replace the uppercase placeholder with the Amplify branch origin:

       sam deploy --guided --capabilities CAPABILITY_IAM --parameter-overrides "AmplifyOrigin=https://YOUR_AMPLIFY_BRANCH_HOST"

   The guided deployment creates the API, Lambda function, and DynamoDB table. Record the ApiBaseUrl stack output.

3. In the deployed Lambda console, open **Configuration → Environment variables → Edit**, add `GNANI_API_KEY`, enter the real value directly in the console, and save. Do not put the key in the SAM template, a SAM parameter, a command, Amplify, frontend code, build logs, or Git. After future deployments, check this setting again and restore it in the console if needed.

4. In Amplify Hosting branch environment settings, set `VITE_API_BASE_URL` to the ApiBaseUrl output. This value is a public endpoint URL, not a credential. Rebuild the branch after changing it.

For local development, keep the existing .env as-is and continue using npm.cmd run dev; Express reads GNANI_API_KEY from that backend-only file. The Vite proxy works without VITE_API_BASE_URL. Do not commit .env. .gitignore excludes .env, data/, legacy server/data/, .aws-sam/, and local SAM/npm working files.

### Audio and API Gateway limits

The browser records at most 25 seconds and converts the recording to mono 16 kHz PCM WAV before upload. The Lambda deployment accepts at most 4 MiB of WAV upload and 4 MiB of binary audio response. The body is decoded from API Gateway's base64 event representation before Express parses multipart form data. WAV TTS output is returned in a Lambda proxy response with isBase64Encoded: true; API Gateway turns it back into audio bytes for the browser. The SAM CORS configuration exposes X-Readback-Token, which the browser needs to confirm the exact read-back.

AWS documents a 10 MB HTTP API payload limit and 30 second integration timeout, and a 6 MB synchronous Lambda invocation request and response limit. Because binary proxy bodies use base64 inside the Lambda event/response, the 4 MiB audio caps leave space for base64 expansion and API metadata. SAM sets the API integration timeout to 29 seconds; Lambda times out at 28 seconds and its Gnani HTTP timeout is 24 seconds so an upstream call does not exceed the gateway window. Over-limit or failed speech requests return an error and do not create a transcript, audio result, or order. See [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [SAM HTTP API CORS](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-httpapi-httpapicorsconfiguration.html), and [Amplify build settings](https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html).

SAM template validation (`sam validate --lint`) passed. A direct esbuild bundle of the Lambda entry passed, and `server/package-lock.json` validates offline. The full `sam build` could not complete in this workspace: its online attempt exited with npm's “Exit handler never called”; an offline retry confirmed the locked `vary@1.1.2` tarball is not cached (`ENOTCACHED`) and emitted Windows temporary-directory cleanup warnings (`EPERM`). No AWS deployment or live Lambda/API Gateway/DynamoDB test was run. The live Gnani smoke attempt also remains unverified because its first request stopped with `EACCES` before a provider response.
