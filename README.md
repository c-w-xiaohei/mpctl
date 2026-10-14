# mpctl

Edit WeChat MP articles from local UTF-8 HTML and JSON files. The browser extension connects the CLI to the site's editor; the CLI handles local files. Body, field, upload and cover operations **never imply SAVE, publication or preview delivery**.

## Requirements and setup

- Bun 1.3.14
- Google Chrome or Chromium with MV3 support
- A local broker and extension running under the same user

```sh
bun install --frozen-lockfile
bun run build
export MPCTL_PAIRING_CREDENTIAL='replace-with-a-private-token'
```

Keep the pairing credential private. In Chrome, enable Developer mode at `chrome://extensions`, load `packages/extension/.output/chrome-mv3`, and configure the same broker address and credential in the extension popup. The default broker address is `ws://127.0.0.1:17381/bridge`.

The examples below use the built `mpctl` bin (Bun required). During source development, replace `mpctl` with `bun run packages/cli/src/main.ts`.

```sh
mpctl connect --extension '<installed-extension-id>'
```

Already connected: returns `connected:true`. Otherwise: exits nonzero with an instruction and, when the extension ID is known, `connectionPageUrl`. Open that URL in the browser/profile where the extension is installed. CLI does not launch a browser, choose an account, or log in. Set `MPCTL_EXTENSION_ID` to omit `--extension`. The connection page closes after success or failure.

Commands start/reuse the broker on demand. Do not run `status`, `broker start` or `connect --reload` before every edit.

## Edit an existing draft

```sh
mpctl article list
mpctl article open '<candidate>'
# Use article and bodyHash from the successful open result:
mpctl article pull '<article>' --body ./body.html
# Edit body.html locally, then use the hash observed before editing:
mpctl article push '<article>' --body ./body.html --expected-hash '<bodyHash>'
```

`list` returns `articles` with `candidate` and `title`. A candidate is a draft locator, not a title or permanent article ID. If you already know the candidate, start with `open`.

**The first confirmed `open/new` result includes `article`, `bodyHash` and the durable `snapshot`. No follow-up `current` is needed.** Open reuses the exact draft's valid editor without refreshing or overwriting unsaved content. Ambiguous targets or duplicate editors are rejected, not automatically closed.

`pull` writes actual editor HTML to the requested file and returns `bodyHash`. The directory must exist. Existing files are rejected unless `--overwrite` explicitly permits atomic replacement. Unknown writes should be inspected into a different file so the local source is preserved.

`push` replaces the whole body. Its expected hash must be from the page, not computed from the modified local file. Stale versions return `content_conflict` before mutation. Successful normalized `bodyHash` is in `snapshot.effect`; another pull is optional, not required just to get a hash. The source file is not changed.

## Prepare a new article

```sh
mpctl article new
# With a local HTML draft already prepared, use new's article and bodyHash directly:
mpctl article push '<article>' --body ./body.html --expected-hash '<bodyHash>'
```

New creates an **unsaved editor page** and returns its live reference. It refuses to create another when a new-editor page already exists. To recover that existing page, use `article current --new` instead.

**New-article first SAVE remains unsupported.** The current native SAVE implementation requires a supported saved single-article editor and a verifiable manual-history baseline. New-article identity/document transitions are not yet supported. Do not treat this workflow as a complete create-and-save pipeline.

## Edit fields independently

```sh
mpctl article inspect '<article>'
# fields.json: {"title":"Title","summary":"Summary"}
mpctl article update '<article>' --fields ./fields.json --expected-hash '<fieldsHash>'
```

Ordinary `inspect` reads only `title`, `author`, `summary` and `fieldsHash`; it does not depend on body or cover reads. The field hash preserves the raw strings. Empty summary is the actual control value, not the platform's eventual automatic summary.

Update accepts a nonempty partial JSON object. Omitted fields stay unchanged; empty strings clear controls. Local limits are 64/8/120 UTF-16 code units for title/author/summary, not a guarantee about platform character rules. Partial or uncertain updates are not automatically continued. Body and cover stay unchanged; no save occurs.

## Images and cover

```sh
mpctl asset list '<article>'
mpctl asset upload '<article>' --file ./image.png
mpctl article cover '<article>'
mpctl article cover '<article>' --asset '<asset>' --expected-hash '<coverHash>'
# Alternatively select an observed platform image already in the body:
mpctl article cover '<article>' --from-body 1 \
  --expected-body-hash '<bodyHash>' --expected-hash '<coverHash>'
```

- List returns `scope:"visible-page"` and `cards`, not a whole-account catalogue.
- Upload accepts PNG/JPEG/GIF/WebP with a conservative 2 MiB budget and signature checks. Duplicate filenames are rejected, not renamed automatically.
- A first confirmed upload returns an `asset` card beside `snapshot`, usable for cover without an extra list. The handle is bound to the same article/document; historical replay/status does not recreate it.
- `thumbnailUrl` is a thumbnail, **not a body-source URL or permanent material ID**. The CLI does not derive an original by changing its size suffix. Upload does not insert into the body, and an explicit uploaded-image insertion workflow is still missing.
- Cover without write options is read-only. Sources are mutually exclusive; body selection additionally requires the body version and a positive, one-based image index excluding separators.
- Body-image cover uses the checked platform `data-src` image and official default centered crop. Material cover operates only on an already-visible, unique native menu. Hidden controls fail closed; there is no debugger/pointer workaround or permission expansion.
- `coverHash` versions preview URLs/visibility, not crop coordinates or publication settings. Cover does not alter body/fields or save.

## Inspect and explicitly save

```sh
mpctl article inspect '<article>' --all > state.json
mpctl article save '<article>' --expect state.json
```

Full inspection returns the article reference, actual fields, and `bodyHash`, `fieldsHash`, `coverHash`. Two matching observations are required; detected drift returns `content_conflict`. This is **not an atomic snapshot**, implicit authorization, or independent cloud proof.

SAVE reads that file locally, rejects malformed or different-article state, and passes the existing three expected hashes to the extension. It does not replace the file, reread to adopt a newer version, or rely on a hidden “last inspection” cache. All three versions must still match before one native SAVE.

Current SAVE supports saved single-article drafts only. Fresh manual-save history confirms the action and the helper restores its owned history display. Success is `settled`, `outcome:"confirmed"`, `persistence:"unverified"`, `result.status:"ok"`. There is no post-save refresh, reload, cloud reopen, or independent persistence verification. The current reference remains usable while its document identity remains valid.

`article check` is optional: finite `errors` and `warnings` for local field conditions and whitespace-only HTML. It is not a save prerequisite or publishing-readiness guarantee; nonempty HTML semantics, cover and platform settings remain unchecked.

## Recover a page or investigate an unknown operation

```sh
# Only read an already-open editor; no navigation or writes:
mpctl article current
# When several editors exist, explicitly select the existing one:
mpctl article current --candidate '<candidate>'
mpctl article current --new
# When an operation timed out or lost its reply:
mpctl operation status '<original-operation-id>'
```

`current` is for existing pages, lost references and explicit multi-page selection—not a required step after open/new. Without selection it requires a unique supported editor in the managed group, not the active tab. `--candidate` and `--new` are mutually exclusive. An unavailable page bridge is not silently refreshed or replaced.

Article and asset handles are temporary background-owned bindings. CLI exit or transport disconnect does not erase them while the same background/document survives; extension reload/background restart loses them. A saved string cannot revive a lost binding. **Only the original execution's successful live reply supplies a handle; historical same-key calls and status return execution facts, not restored authority.**

Mutations/navigation print their operation ID to stderr before submission; `--quiet` does not suppress it. `--operation` is an advanced same-request resubmission option: retain the original ID, target, input and expected versions. Query the original ID first when uncertain. **Do not switch keys, rename an unknown upload, refresh to bypass a lock, or automatically replay.** Current page contents and later filename presence cannot prove the original operation ended.

Status query success exits 0 even when the queried operation failed. Inspect `snapshot.state`, `snapshot.result`, `snapshot.effect` and `issue`. Partial effects, first cause and cleanup diagnostics remain visible; original missing evidence may be unrecoverable. Old pending locks and historical verified/unverified records retain their original semantics.

## Diagnostics and maintenance

- `status`: transport connection only, not account login/editor readiness. `status --details`: running component versions (`null` if unadvertised).
- `connect --reload`: explicit maintenance reload of an already-connected extension; waits for a different session. Old references become invalid. It is not a routine editing step.
- `broker start`: optional maintenance-only startup. Normal commands already start/reuse it.
- `workspace cleanup`: explicit repair of historical duplicate `mpctl` tab groups. Moves their tabs into the locked group without closing tabs or modifying article content; not a business prerequisite.

Source protocol is **`0.15.0`**; broker, CLI and extension must be updated together. Changing source or rebuilding does not replace a running broker/installed extension. The durable ledger remains schema 2; this update does not reset or trim it. The extension's manifest version is separate from the wire protocol.

CLI migration: SAVE's three command-line hash flags have been replaced by `--expect <json-file>`. The wire request and native pre-save checks still carry all three hashes.

Broker configuration can be isolated with `MPCTL_BROKER_SOCKET`, `MPCTL_BROKER_WS_PORT`, `MPCTL_BROKER_CONFIG`. The broker requires a private socket parent and stores newly confirmed pairing settings in `${XDG_CONFIG_HOME:-~/.config}/mpctl/broker.json` (directory `0700`, file `0600`). Environment credentials take precedence; an existing broker does not replace saved credentials.

For development, run `bunx wxt --host 127.0.0.1 --port 3000` in `packages/extension` and load `.output/chrome-mv3-dev`. Keep WXT running for dynamic content-script registration. Do not enable production and development extensions on the same page. Full reload can invalidate the content bridge; current does not repair it.

Help/version are text; success is one JSON object on stdout; failures are JSON on stderr with a nonzero exit. Interactive waiting hints are optional with `--quiet`. Read leaf help for task-specific constraints.

## Verification limits and tests

### Nexus development diagnostics

- CLI / broker: set `MPCTL_NEXUS_DEBUG=1` to enable Nexus's internal DEBUG logger. Logs go to stderr; CLI stdout remains JSON. A broker started by that CLI inherits stderr so its logs are visible. An already-running broker must be started with the flag separately; it is not restarted automatically.
- Extension: WXT development builds enable Nexus logging in background, CONTENT, MAIN, popup and connection-page contexts. Set `VITE_MPCTL_NEXUS_DEBUG=0` before starting WXT to disable it. Production builds disable these logs. Inspect the matching browser DevTools console (background via the extensions page).
- Lines include runtime, severity and Nexus scope. Argument payloads, identities, URLs and error stacks are omitted; only typed Nexus error codes are retained. This uses the library's existing log events, not a new trace system, and does not guarantee a log for every successful call. Do not share unreviewed browser/server console output.

The supported saved-editor shape is exactly one visible current index-0 article. Native navigation and body/field operations recheck route, document, login and saved-item facts; editor changes between checks and mutation can still race. No private MP HTTP API or bare authenticated editor URL is used. This does not establish support for every account/page variant.

Historical live body/field checks and an older independently reopened SAVE are recorded under `tmp/reports/`; they do not establish the current native-only SAVE's cloud persistence. Current native-only SAVE, official body-image cover and fresh upload still lack completed real-write acceptance. Historical unknown uploads/SAVE remain unchanged and were not replayed. Other drafts are read-only; any future live write acceptance requires an authorized dedicated article. Never publish, delete drafts, scan QR codes or send previews as verification.

```sh
bun run typecheck
bun run lint
bun run build
bun run test
bun run test:browser
```

Browser tests use isolated persistent Chromium, local fixtures under `https://mp.weixin.qq.com`, an ephemeral paired broker and real CLI child processes. External traffic is blocked. Set `MPCTL_CHROMIUM_EXECUTABLE` to choose an executable. These tests prove isolated behavior, not live platform acceptance.
