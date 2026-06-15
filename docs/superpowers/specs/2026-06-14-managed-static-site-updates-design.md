# Managed Static Site Updates Design

## Goal

Let Beep function as a live coding agent for managed static websites.

When the agent has already created a managed static preview and the user asks it
to change that website, the existing public site URL should keep working. The
control plane should rebuild a fresh validated snapshot from the updated runtime
workspace files, recreate the backing static-site container, and keep the same
`/sites/<siteId>/...` URL.

## Current Baseline

The current managed static-site path is implemented but create-only:

- `preview_container_create_static_site` requests a managed static-site
  container for files already written inside the runtime workspace.
- `createStaticSitePreview` validates the requested source, creates an immutable
  snapshot under control-plane state, starts a Docker container with the snapshot
  mounted read-only, records the site, and returns URLs.
- `POST /api/sites/<siteId>/stop` stops the managed container and removes the
  snapshot.
- `GET /sites/<siteId>/...` proxies to the recorded container port.

This gives a safe first preview, but not a live coding loop for static sites.
After creation, later edits to the runtime workspace do not affect the mounted
snapshot.

Live dev-server previews already support iterative updates through
`preview_port_expose`, because the control plane proxies to a server running in
the runtime. This design closes the equivalent gap for managed static previews.

## Selected Approach

Use same-URL redeploy for managed static previews.

An update should:

1. Validate that the target site exists, is running, and belongs to the current
   runtime.
2. Re-run the same static-site source validation used for create.
3. Build a new snapshot under a temporary versioned snapshot ID.
4. Start a replacement container from the new snapshot.
5. Confirm the replacement container has a mapped localhost port.
6. Update the site record to point the same `siteId` at the replacement
   container, host port, and snapshot.
7. Remove the old container and old snapshot after the record swap succeeds.

The user-facing URL remains stable:

```text
http://<control-plane>/sites/<siteId>/
```

The direct Docker-mapped URL may change because Docker assigns a fresh host port
for the replacement container. The stable control-plane URL is the contract.

## Why This Approach

This preserves the useful safety properties of the current static preview:

- the runtime never receives Docker authority;
- snapshots stay read-only inside preview containers;
- each update reuses existing path, symlink, file-count, byte-count, depth, and
  suspicious-file validation;
- a failed update does not mutate the currently served site;
- the control plane remains the only component that starts, stops, and records
  host containers.

It also gives the agent the behavior a user expects from a live coding surface:
the browser can remain on one site URL while the agent revises the underlying
website.

## Tool Model

Add a second managed static-site tool:

```text
preview_container_update_static_site
```

Action:

```text
preview.container.updateStaticSite
```

Inputs:

```json
{
  "siteId": "existing managed site id",
  "sourcePath": "/workspace/path/to/site"
}
```

The tool should be restricted and reviewed by the same gatekeeper domain as
static preview creation. The user intent must clearly authorize updating the
named or referenced site from the given source path.

The tool result should include:

- `siteId`
- `status`
- stable `proxyUrl`
- current `directUrl`
- `previousContainerName`
- `containerName`
- `snapshotFileCount`
- `snapshotTotalBytes`
- `updatedAt`

## Operator API

Add an operator endpoint:

```text
POST /api/sites/<siteId>/update
```

Request body:

```json
{
  "sourcePath": "/workspace/path/to/site"
}
```

This endpoint is operator-token-only. It is useful for manual testing and for
future UI controls, but the agent path should still go through the tool broker
and gatekeeper.

## Control-Plane Data Flow

```text
agent edits site files in runtime workspace
  -> agent calls preview_container_update_static_site
  -> runtime extension sends /internal/tools/call
  -> control plane validates token and action
  -> gatekeeper reviews static-site update intent
  -> broker calls updateStaticSitePreview
  -> source validation runs against updated workspace source
  -> new snapshot is created
  -> replacement container starts
  -> site record swaps to replacement container/port/snapshot
  -> old container and snapshot are removed
  -> stable /sites/<siteId>/ URL serves new content
```

## Failure Handling

Validation failure:

- Return a 400-style tool error.
- Keep the existing site untouched.

Replacement container start failure:

- Remove the new snapshot if it was created.
- Remove the replacement container if it was partially started.
- Keep the existing site untouched.

Record swap failure:

- Remove the replacement container and new snapshot when possible.
- Keep the existing site record untouched.

Old container or snapshot cleanup failure after a successful swap:

- Keep the new site live.
- Record cleanup diagnostics in audit state.
- Do not roll back to the old container unless the new site cannot be served.

Unknown or stopped site:

- Return 404 for unknown site IDs.
- Return 409 or 410 for stopped sites.
- Do not recreate stopped sites through update; creation remains a separate
  operation.

## State Changes

Extend site records with update metadata:

```json
{
  "revision": 2,
  "createdAt": "...",
  "updatedAt": "...",
  "previousContainerName": "beep-preview-site-old",
  "previousSnapshotPath": "...",
  "lastUpdate": {
    "sourcePath": "/workspace/path/to/site",
    "snapshotFileCount": 4,
    "snapshotTotalBytes": 12000
  }
}
```

Existing records without `revision` should be treated as revision `1`.

## Security Boundary

The runtime can request an update but cannot perform it directly.

The update path must not:

- mount the runtime workspace directly into the preview container;
- mutate snapshots in place;
- give the runtime Docker access;
- accept a host path from the runtime;
- serve files outside the validated workspace source;
- expose hidden gatekeeper evidence or policy rationale to the agent.

All runtime-supplied paths remain runtime workspace paths. The control plane is
responsible for resolving them to trusted host paths through existing evidence
collection.

## Tests

Add focused tests before implementation code:

- updating a site creates a new snapshot and preserves the same `siteId` and
  `proxyUrl`;
- update failure during source validation leaves the existing site record,
  container, and snapshot untouched;
- update failure during replacement container start removes the new snapshot and
  keeps the existing site untouched;
- update records cleanup diagnostics if old container removal reports a missing
  container;
- `POST /api/sites/<siteId>/update` requires operator auth;
- the tool manifest exposes `preview_container_update_static_site` with
  restricted review semantics;
- route/broker tests prove `preview.container.updateStaticSite` reaches
  `updateStaticSitePreview`.

Manual verification should create a static preview, edit the source workspace
files, run the update path, reload the existing `/sites/<siteId>/` URL, and
confirm the content changes without changing the visible URL.

## Out of Scope

- Hot module replacement for framework dev servers.
- Multi-user site ownership or shared-team authorization.
- Version history UI.
- Rollback endpoint.
- Updating stopped sites.
- Long-lived public hosting beyond the local control-plane preview proxy.
