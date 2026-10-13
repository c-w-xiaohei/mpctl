# Native acquisition fixture inputs

`platform.json` owns the minimal sanitized inputs for native-handler tests. It is
part of the extension test tree; no ignored `tmp` packet, browser connection,
fetch, installed Vue dependency, or authenticated platform state is required.

Provenance: controller's read-only October 2026 Vue 2.7.15 home/draft association,
model, reporting-dependency and toptips observations. These are **selected public
platform function definitions**, not copied home render/account markup, real
draft content/IDs, credentials or full WeUI/base bundles. Synthetic context and
account/candidate/model values are supplied by `native-handler-fixture.ts`.

The three retained module factories (CGI ~13KB, comm_report ~2KB, idkey <1KB) are
needed to identify and execute the reviewed async fingerprint/timeout-report
continuations without replacing their behavior. The native data/fixData/getter
definitions identify initialization/model semantics. The six small toptips
option definitions replace the formerly unnecessary ~650KB whole-library
fingerprint with inspection of the actually instantiated source-local component.
Fixtures execute the exact native functions; returned end/effects come from the
production adapter and ledger, never a fixture `ended` RPC.

Default saved shape uses inherited component/parent options and a component/slot
VNode with an aliased Edit node. Instance methods follow native Vue binding.
Tests additionally exercise distinct ambiguity and callback-bearing replacements.
Public bound shape identifies the supported normal initialization, not arbitrary
hidden closure targets or adversarial same-text functions.
