# mpctl

mpctl moves an article body between a local UTF-8 HTML file and a supported MP editor, reads its title, author, and summary, and supports version-checked grouped updates to those fields. Field updates passed isolated acceptance, safety review, and dedicated-test-article live write/readback checks. The browser extension provides the editor connection; the CLI reads and writes files locally.

## Requirements

- Bun 1.3.14 (workspace package manager)
- Google Chrome or Chromium with MV3 support
- A local broker and browser extension running under the same user

Install and build:

```sh
bun install --frozen-lockfile
bun run build
```

## Start and connect

Configure a non-empty WebSocket-token-compatible pairing credential for the broker process. Keep this value private; it is not a URL parameter and must not be shared in logs.

```sh
export MPCTL_PAIRING_CREDENTIAL='replace-with-a-private-token'
```

The broker listens on `ws://127.0.0.1:17381/bridge` by default and uses the user's default local IPC socket. `MPCTL_BROKER_SOCKET` and `MPCTL_BROKER_WS_PORT` may override those addresses for isolated instances.

The broker creates a private (`0700`) directory for a new IPC socket and repairs its own existing `mpctl` directory if needed. A non-private custom parent, symlink, or wrong-owner directory is rejected rather than changing unrelated directories. After a newly spawned broker is confirmed, the CLI stores its pairing credential in `${XDG_CONFIG_HOME:-~/.config}/mpctl/broker.json` (`0600` in a `0700` directory). Later `broker start` can use that file without a shell credential variable. An existing broker never causes the CLI to replace saved pairing settings; `MPCTL_BROKER_CONFIG` selects a dedicated custom config file, and an environment credential takes precedence.

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/extension/.output/chrome-mv3`. Configure the same broker address and pairing credential once in the extension popup. You can then connect explicitly from the CLI:

```sh
bun run packages/cli/src/main.ts connect --extension '<installed-extension-id>'
bun run packages/cli/src/main.ts status
bun run packages/cli/src/main.ts status --details
```

`connect` checks the existing plugin connection. When disconnected, it exits nonzero with a JSON `not_connected` error containing `instruction` and, when an extension ID is available, `connectionPageUrl` (`chrome-extension://<id>/connect.html`). The agent determines where the installed browser/profile actually runs and uses tools in that environment to open the returned URL. CLI does not launch a browser, choose a profile, or wait for this handoff. Set `MPCTL_EXTENSION_ID` to omit `--extension`; without an ID, the instruction explains how to obtain one or connect from the extension UI. Background uses its stored settings; the page closes itself after either success or failure. Run `status` to confirm connection before retrying the original command. Ordinary startup, status/body commands and disconnects do not silently reconnect.

`connect --reload --extension '<installed-extension-id>'` sends reload through the existing IPC → broker Relay → background channel only when already connected. When disconnected, it returns the same connection-page handoff without dispatching reload; complete the handoff and rerun the command. Background stores a 30-second one-use reconnect intent in `storage.local`, reloads, and the new background consumes that intent before dialing once. CLI verifies a different broker session, even if reconnect is too fast to observe the offline instant. If reload/reconnection fails, inspect the returned error and run `connect --extension '<id>'` for connection instructions. Extension reload still invalidates article references; obtain a fresh reference afterward.

CLI commands/options/help are parsed by Commander. Root help separates everyday commands from maintenance; `mpctl article --help` explains article selection and the file workflow; leaf help provides required inputs, outputs, examples and operation-specific constraints. Running a command group without an action shows its help successfully. Inherited global options such as `--quiet` appear in subcommand help. Options may appear in any order or use `--body=path`. Help/version are text; successful operations produce one JSON result, failures produce JSON errors with nonzero exit status. Interactive terminals receive a waiting notice on stderr after one second; `--quiet` suppresses it, and pipes remain clean. The CLI package exposes `mpctl` via its built `dist/main.js` bin (Bun required).

Start normal work with `connect`: `connect`, `status` and article operations start/reuse the broker on demand. `broker start` is an optional maintenance command for starting only the background process without connecting a browser. `workspace cleanup` is for consolidating duplicate workspace groups, not a prerequisite for article work.

`status` reports transport connection only, not login/editor readiness. `status --details` reports running broker/extension protocol versions; `null` means the component does not advertise that fact. Known plugin-version mismatch blocks workspace commands. Updating source does not replace an already running broker or installed extension.

For a paired, version-matched session, the broker checks the existing read-only background status service every 20 seconds with a bounded call. This keeps MV3 WebSocket traffic within Chrome's activity window; disconnect, failed status or session replacement stops the timer. It does not reconnect, launch a browser or issue article operations.

Services and CLI workflows propagate typed `Result` values for expected failures throughout fallible processing and conversion: successful values are `Ok`, and expected domain failures are `Err`, rather than exceptions used for normal control flow. Current source protocol is `0.14.0`; always inspect running versions after a controlled update. Historical upload results reported as unknown are retained without replay, even when later reads observe a same-filename card. Public cover/save production acceptance limits are described below. The envelope remains `status: "ok"` / `status: "error"`. Codec `serialize` and `deserialize` are asynchronous and return `Result`; malformed envelopes produce `Err({ code: "invalid_result_envelope" })`. The CLI keeps its compact interface: success is one JSON result, while `Err` becomes a nonzero exit and minimal structured JSON on stderr.

The extension keeps one durable workspace-group lock in `storage.local`. Reloading the extension or restarting Chrome reuses that group if it still exists. Only an exact missing-group result permits recovery of an existing `mpctl` group or creation of a replacement; a transient Chrome lookup error does not create another group. To consolidate older duplicate groups without closing their tabs, run:

```bash
bun run packages/cli/src/main.ts workspace cleanup
```

Cleanup moves the duplicate groups' tabs into the locked group and reports counts. It preserves editor contents and unrelated groups.

The popup's **显式连接** remains available. If stored settings arrive while you edit a field, input takes precedence. **取消连接** cancels an in-progress connection and a late handshake cannot reconnect it.

For WXT hot reload during development, start `bunx wxt --host 127.0.0.1 --port 3000` in `packages/extension` and load `packages/extension/.output/chrome-mv3-dev` in Chrome. Keep the dev server running: this manifest has no static `content_scripts`; WXT registers `mp` dynamically. If the server was stopped and Chrome reports no registered `mp` script, start it, reload the installed extension once, and refresh the test page. A reload disconnects the broker; run CLI `connect` again. The production build uses the static `chrome-mv3` manifest. Do not leave both versions enabled on the same MP page.

The unpacked development extension currently builds with manifest version `0.1.0`. The separate browser-test bridge fixture uses `0.0.1`; these values identify build artifacts, not a published release.

The extension creates one `mpctl` tab group on demand and reuses it for concurrent commands in the same background instance. Concurrent draft-list requests also share one discovery/open/readiness attempt for the list page. It validates a stored group with Chrome when restoring a background session; a temporary validation or session-read error makes the next command check the stored pointer again before using or replacing the group. If Chrome created a group but updating its title or saving its session pointer failed, an immediate background restart may leave a group the extension can no longer identify.

## File-driven body workflow

The body workflow targets saved drafts matching the observed single-visible-item shape and fresh blank articles. `article open` and `article new` ask the installed extension to open the site's own target, wait for the exact editor document, and return its article reference as JSON on stdout. They do not print a manual-click instruction or expose prepare/complete attempts. Browser navigation is part of the product extension, not an external automation driver.

The earlier automatic CLI flow passed real new-article acceptance: `connect --reload → article new → pull → local HTML editing → push → pull`. The essay's text and checked inline styles survived editor normalization, and a real saved draft passed read-only `list → open → pull`. Evidence is recorded in `tmp/reports/T73-cli-only-essay-acceptance.md` and `tmp/reports/T74-persistent-group-and-closeout.md`. Those live checks predate the hash/Relay cleanup; the current revision is verified with isolated tests. A bare editor-looking URL without a working editor JSAPI fails closed.

```sh
bun run packages/cli/src/main.ts status
bun run packages/cli/src/main.ts article list
# The extension opens the selected draft's observed native target:
bun run packages/cli/src/main.ts article open '<candidate-from-list>'
# Use the article reference returned by `open`:
bun run packages/cli/src/main.ts article pull '<article-reference>' --body './draft body.html'
bun run packages/cli/src/main.ts article push '<article-reference>' --body './draft body.html' --expected-hash '<bodyHash-from-open-new-current-or-pull>'

# Or create a fresh article in the logged-in account:
bun run packages/cli/src/main.ts article new
# Reacquire the unique existing editor without creating another page:
bun run packages/cli/src/main.ts article current
# Explicitly replace an existing pulled file:
bun run packages/cli/src/main.ts article pull '<article-reference>' --body './draft body.html' --overwrite
```

`article list` returns an opaque candidate for a draft group; pass it to `article open`. No browser click is required between commands. The extension uses the observed site target and validates source, target route, document, editor readiness, and current item before issuing a reference. `article new` creates a fresh target only when the managed group has no existing new-editor page; otherwise it refuses without adopting or overwriting that page. Unknown or ambiguous native targets fail closed; the CLI never constructs a bare authenticated editor URL or calls a private MP HTTP API. The old CLI `prepare` and `complete` commands have been removed.

New-article navigation checks all available MP home sources for ambiguity. A public site-root tab may be acquired only without duplicating a root/home already in that inventory; it waits for the site's normal redirect rather than selecting an arbitrary account tab. Body content remains on the resident MAIN-world Nexus bridge; short-lived MAIN scripting is used only to observe native navigation targets.

`article list` returns the observed draft-group locator in the `candidate` field. Repeated or failed lists do not revoke it. `open` inspects the current list and requires exactly one matching group before navigation; a deleted, absent, or ambiguous target is refused. Treat candidates as opaque locators, not permanent article IDs or titles.

The managed group keeps one home/root, one draft list, one new-editor page, and one editor per SavedID. Ordinary `open` reuses the same draft's unique valid editor without reloading it or overwriting unsaved content; concurrent requests from the same list document share one open attempt. An existing but unbound/invalid editor is not silently replaced. Creation and placement into the group share a serialized identity check, so requests from different source documents and duplicate-group cleanup cannot bypass uniqueness. Distinct saved articles remain distinct; there is no arbitrary total-tab cap. Existing/manual duplicates fail closed rather than being automatically closed or having their unsaved content discarded.

**2026-10-13 decision (protocol `0.14.0`):** explicit `save` checks the current body/fields/cover hashes, clicks native manual SAVE once, observes its confirmation and completes owned history-panel cleanup. It does not refresh the draft list, reload the editor, reread canonical content, or independently verify cloud persistence. Success is a settled snapshot with `outcome: "confirmed"`, `persistence: "unverified"`, and `result.status: "ok"`. SAVE does not invalidate the current article reference. Existing verified history remains readable; historical unresolved SAVE/navigation is not unlocked by this change.

`open/new` return an ephemeral article reference used by `pull/push`. The background owns these bindings independently of CLI and broker sessions. CLI exit or a WebSocket disconnect does not erase them while the same background remains alive; a confirmed document/route change makes that binding unusable. Extension reload/background restart loses the reference map, so obtain a fresh reference. A saved string cannot restore a lost binding.

`article current` reads the unique supported editor in the managed group and returns a fresh reference/hash. It never creates, reloads or writes a page; multiple editor tabs return `target_ambiguous`. It can use a surviving content session after background restart, but full extension reload can invalidate that session; an unavailable bridge remains a page error, not a new-article fallback.

Pull defaults to no-clobber: an existing destination returns `file_exists`; `--overwrite` explicitly permits replacement. HTML is fully written/synced to a private same-directory temporary file and installed atomically, so failure does not truncate local edits. Destination directories must exist. Inspect unknown writes by pulling into another path, preserving the source.

Navigation failures after creating an editor include `pageCreated:true` and a safe stage; inspect that page before repeating new/open. Opens of distinct drafts keep request-local targets, without a group-keyed handoff slot. list/open/new/current share the navigation RPC budget. Timeout does not prove a background operation stopped; navigation and writes are not automatically replayed.

Successful operation stdout is one JSON result; help/version are text. Failures return nonzero status and JSON on stderr. Inspect unknown writes by pulling into another file before deciding whether to retry.

CLI output contains only information needed for the next step:

| Command                       | Result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `status`, connected `connect` | `connected`                                                         |
| `status --details`            | `connected`, `brokerVersion`, `extensionVersion`, `expectedVersion` |
| `article list`                | `articles` containing `candidate` and `title` for selection         |
| `article open/new/current`    | `article`, `bodyHash`                                               |
| `article pull/push`           | `bodyHash`                                                          |
| `article inspect`             | `title`, `author`, `summary`, `fieldsHash`                          |
| `article update`              | `fieldsHash` (title/author/summary partial update)                  |
| `article check`               | `errors`, `warnings` (supported checks, not a readiness guarantee)  |
| `asset list`                  | `scope:"visible-page"`, `assets` with opaque handles and observed metadata |
| `asset upload`                | Opaque `asset`, `filename`, observed `thumbnailUrl`                  |
| `article cover`               | `coverHash` (read-only without paired write options)                 |
| `article save`                | Settled native-confirmed snapshot, persistence unverified            |
| `broker start`                | `started` (whether this call started a new process)                 |
| `workspace cleanup`           | Cleanup counts                                                      |

Exit status communicates success; results do not echo input paths/references or add success flags. Errors contain `code`, relevant facts such as `stage`, `pageCreated:true` or `connectionPageUrl`, and at most one short `instruction` when needed. There are no duplicate `message`/`action` fields or automatic reminders to read help.

For saved drafts, body access requires exactly one visible `.js_appmsg_item`, which must be the current index-0 item. A visible second item prevents opening or later body access. Open/new and pull return `bodyHash`, the SHA-256 of the actual editor BODY HTML. Push requires that caller-observed version: `article push <article> --body <path> --expected-hash <bodyHash>`. If the current HTML differs, it returns `content_conflict` before `setContent`; a successful push returns the normalized current `bodyHash` for the next push. A later pull does not mutate tokens already held by other callers. Clicks, scrolling, and other interactions alone do not invalidate the reference. Push replaces the editor's entire body. It does **not** save, publish, update the source file, or automatically retry an operation whose result is unknown. After `setContent` is invoked, an uncertain outcome is reported as `write_unknown`.

The implementation rechecks the saved draft's `appmsgid`, route/page binding, and single-visible-item condition before body calls. The observed `data-msgindex="0"` is not a stable item ID. The list and saved-editor route classifiers accept the context query keys observed on those pages, including `reprint_confirm` on a pre-existing saved-editor tab, without treating their values as article identity; the new-editor route has its own narrower allowlist. Final handoff URL validation allows only the observed `timestamp` update: origin, path, fragment, semantic route, and all other query pairs must remain equal. Programmatic/platform-driven item switches and atomicity against an in-flight operation are unproven. `article list` and `article new` report `not_logged_in` only for the observed timeout-page combination: body classes `page_error page_timeout`, `#info` containing “登录超时”, and a same-origin `#jumpUrl` to `/cgi-bin/loginpage`. Other login or permission modes remain unsupported; an empty list without positive authenticated-list evidence fails closed. The live passes are bounded to one synthetic new-article round trip and one saved-draft read; they do not establish broad MP compatibility, saved-draft writes, cloud persistence, or atomicity.

For a new article, the extension also checks the bound page status after editor readiness and before issuing its article reference or dispatching a body read/write. A newly observed, complete login-timeout marker stops the operation with `not_logged_in`; a confirmed page change returns `target_unavailable`, while an uncertain Chrome lookup or non-ready current page returns `page_failed`. These checks do not make an in-flight editor operation atomic with page changes.

For a saved draft, the extension revalidates the selected draft group after editor readiness and reading its initial body hash, before issuing its reference. A complete timeout marker returns `not_logged_in`; a confirmed invalid target is rejected, and an indeterminate Chrome lookup returns `page_failed`.

Before a push, the MAIN editor service serializes writes for that editor, reads current BODY HTML, and compares its SHA-256 to the caller-supplied expected hash. A match permits `setContent`, followed by a readback of editor-normalized HTML and its hash. This is check-before-set, not an atomic compare-and-set: an editor change between the read and JSAPI mutation can still race.

The background uses one Chrome Nexus instance for document and control sessions. Content provides its DOM services and Relays the MAIN editor Token, publishing `app.editorReady` after registration; background observes identity updates without a second connect. Content policy and MAIN JSAPI dispatch synchronously recheck login, route and saved-item facts. A blocked read reports `page_failed`; a rejected dispatched write remains `write_unknown` when its outcome is unproven. WS disconnect withdraws the broker Relay while keeping IPC status available; explicit reconnection permits later calls, without replaying old writes.

Content bootstrap waits for the DOM to be parsed (`interactive` or `complete`), not for all image/subresource downloads to finish. It still requires the MAIN editor's supported-version/readiness handshake and login/route/item guards before relaying editor access. Current-editor discovery rejects a pending frame identity check without deleting its observed binding, allowing that check to settle normally; a pending check is not permission to use the page.

## Article fields

`article inspect <article>` reads three actual controls without touching body or cover. `fieldsHash` is SHA-256 of UTF-8 `JSON.stringify([title, author, summary])`, preserving raw strings; it is separate from `bodyHash`. Empty summary means the actual input is empty, not that the platform's eventual automatic summary is empty. Inspection passed on one real saved editor, with repeat-read stability and unchanged body; this does not prove every page variant.

`article update <article> --fields <json-file> --expected-hash <fieldsHash>` accepts a nonempty partial JSON object containing `title`, `author` and/or `summary` strings. Omitted fields stay unchanged; explicit empty strings clear the control. Unknown keys, null and invalid types are rejected before broker dispatch. Local bounds are 64/8/120 UTF-16 code units, conservatively matching observed controls rather than claiming platform character-count rules; title/author reject line breaks and all three reject NUL. Title editing uses the visible native editor and waits at most one second for read-only mirror confirmation, without setting the hidden field or accessing editor internals. Inspection may read a cleared title as a newline; the hash uses that actual raw value. It neither saves nor publishes. Do not retry `field_update_unknown` automatically; inspect the current fields first. Dedicated live tests passed title update/clear, stale-version rejection, native mirror readback and unchanged author/summary/body. A separate explicitly authorized native save produced a fresh manual-save history entry, and product reopen verified the latest title, fields and body persisted. This is not a CLI save implementation or an implicit effect of update.

Actual-page observations use agent-browser attached to port9222. Business navigation and read verification use the product CLI, not browser automation as a replacement for its runtime. Other drafts remain read-only; necessary production writes use one clearly marked dedicated test article.

Public `0.9.0` explicit save passed production acceptance on a new test input: one guarded push and one save returned a mandatory fresh article reference; same-identity readback confirmed the new marker, one image, unchanged fields/cover and the returned body hash. Save keeps exact pre-save three-hash CAS, then compares the exact post-save current-page body against the fresh saved-document body. It does not strip attributes or ignore image URL differences. The earlier `save_unknown` outcome remains unchanged and was not replayed.

Existing-material cover setting has not passed production acceptance. The restricted extension-owned native-pointer flow has passed isolated full CLI tests with genuine two-level CSS hover, but production permissions have not been expanded. The product does not override styles, activate hidden menus, or use browser automation to bypass this boundary.

Three actual upload attempts remain unknown and were not replayed, renamed or rolled back. Corrected `/sz_mmbiz_` thumbnail readback passed on a real existing card; later same-filename records are not input-byte verification or success results for earlier unknown requests. The latest attempt exposed an untitled intermediate card. The helper now continues guarded full-snapshot reads within its existing bounded wait instead of terminating on the first post-dispatch snapshot error; incomplete persistent snapshots still end unknown, without another upload dispatch. This fix passed regression tests, not a new real-upload acceptance.

Native preview exposed only QR/list-preview options, not a pure webpage viewer; no QR scan or contact send occurred. A reconciliation operator accidentally activated a picker confirm using a stale browser reference; exact post-action body/field/cover reads were unchanged and the owned picker was dismissed. That incident is recorded, not counted as product acceptance. No publish or draft delete occurs during verification. Evidence is in `tmp/reports/preparation-production-canonical-save.md`, `preparation-production-upload-success.md`, `preparation-production-upload-reconciliation-latest.md`, `preparation-p65-interaction-incident.md` and `preparation-production-preview-current.md`; private target/URL checkpoints are not public reports.

The native cover-pointer integration uses only bounded mouse movement to measured, article-owned controls and a verified cleanup position. It checks document/group identity and target visibility, refuses an already-attached debugger, and detaches only its own session. Hidden CSS-only controls return `cover_input_unavailable` when the debugger API/permission is absent; no permission prompt or automatic browser interaction is initiated. Chrome's required `debugger` permission is broader than this implementation and cannot be optional. Adding it to the production manifest and updating the installed extension require separate, explicit authorization; the default production manifest does not include it. The debugger-enabled manifest is used only in an isolated test build, not as an installation workaround.

`article check <article>` reads the supported fields and body without writing, focusing, saving or previewing. It returns finite issue codes in `errors` and `warnings`, not `ready:true`. Current checks use conservative local field bounds and recognize only whitespace-only HTML as definitely empty; nonempty HTML warns that body semantics are unchecked. Cover and platform settings remain unchecked warnings. The `0.6.0` real saved-test-article check, inspect and pull passed after a full reload; the fields/body hashes matched the independently saved/reopened state. `article list` now refreshes its observed native draft-list page so it does not silently reuse the earlier stale list; `open` still validates the selected candidate against the current list. Neither action saves or writes an article.

## Materials, cover and explicit save

`asset list <article>` reads the native image library's visible page, not the whole account. Handles are ephemeral and belong to that article/document. `asset upload <article> --file <image>` sends a Blob with independently validated basename/MIME through Nexus; the local 2 MiB budget is conservative, not a claimed WeChat limit. Upload does not insert a body image, set the cover or save. If a dispatched upload is unknown, do not rename or replay its input. Later filename presence is separate evidence, not a success result for the historical request.

Material thumbnails are observed HTTPS `mmbiz.qpic.cn` URLs without embedded credentials in the `/mmbiz_` or `/sz_mmbiz_` path families. The exact URL is preserved: a thumbnail is not an original body-source URL or permanent material ID, and the CLI never derives an original by changing a size suffix. Filename/thumbnail correlation does not verify a source-file hash.

Upload failures include `uploadFailure:{stage,kind,causeCode,outcome}`. `kind` distinguishes domain errors, Nexus errors, invalid business-result envelopes and unexpected runtime exceptions. `outcome` describes the upload side effect: `not_dispatched`, `unknown`, or `confirmed`. A page reply retains its observed stage through background, Relay and CLI; an RPC failure reports only the boundary that lost the reply, not an invented downstream phase. Nexus codes such as `E_CALL_TIMEOUT`, `E_CONN_CLOSED` and `E_REMOTE_EXCEPTION` are retained as `causeCode`, without raw messages, URLs or stacks. A confirmation deadline reports `confirmationTimedOut:true` and the final observation (for example `card_title_empty`, `new_card_absent`, or `thumbnail_unavailable`). This is not a platform-upload timeout diagnosis. Cleanup cannot erase an earlier failure: its cause is recorded separately in `uploadFailure.cleanup`; successful upload followed by failed cleanup has `outcome:"confirmed"` and `assetCreated:true`, never permission to upload again. Historical unknown results cannot acquire these new diagnostics retroactively.

`article cover <article>` returns only the configured `coverHash`. Writing requires both `--asset <handle>` and `--expected-hash <coverHash>`; it selects an exact current material and uses the supported native crop flow. The version covers primary/square preview URLs and visibility, not crop coordinates or publication settings. It never uploads, changes the body or saves. An unknown cover result is not automatically retried or rolled back; the required-permission restriction above still applies to hidden hover-only controls.

`article save <article> --expected-body-hash <bodyHash> --expected-fields-hash <fieldsHash> --expected-cover-hash <coverHash>` performs one explicit native save of a supported saved single article. All three caller-observed versions must match before save. Fresh manual history confirms the native action; no automatic refresh, reload or post-save persistence comparison follows. Same-key calls return the stored snapshot without repeating SAVE; unknown results require querying the original key, not replay. New articles remain unsupported. This is not independent cloud verification, publication or preview delivery. The `0.9.0` reopen acceptance described above is historical evidence, not the current command's responsibility.

## Tests

```sh
bun run test                 # local behavior and Nexus IPC/Relay suites
bun run test:browser         # built MV3 extension in persistent Chromium
```

The browser suite runs headless using Playwright's Chromium channel; set `MPCTL_CHROMIUM_EXECUTABLE` to use another Chrome/Chromium executable. It starts an ephemeral broker with isolated pairing/configuration, serves local fixtures under `https://mp.weixin.qq.com`, blocks non-local traffic, and invokes real CLI child processes. Coverage includes popup/connection-page reconnection, automatic new/open navigation, stable list targets, body hashes and stale-write rejection, continued access after harmless interaction, saved-item ambiguity rejection, and preserving tabs during duplicate-group cleanup. It also checks current-editor reacquisition/ambiguity, protocol diagnostics, connection-page self-closing, and channel reload without opening a reload page. `isNew:true` identifies the supported editor version, independently of article freshness. Current CLI repair verification is recorded in `tmp/reports/T78-cli-conventions-and-workflow.md`; hash/Relay cleanup history is in T76. These fixtures do not use a live account.
