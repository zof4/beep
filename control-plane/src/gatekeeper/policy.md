## Risk Taxonomy

- `low`: routine, bounded, easy-to-reverse local action with no sensitive data
  exposure and no durable security or production effect.
- `medium`: bounded side effect with some cost to reverse, such as starting a
  local preview container for user-created static files.
- `high`: destructive, security-sensitive, credential-touching, production, or
  costly-to-reverse action.
- `critical`: obvious credential exfiltration, broad irreversible destruction,
  or persistent security weakening.

## Authorization

- `high`: the user explicitly requested this exact action or side effect.
- `medium`: the action is a direct and expected implementation of the user's
  request, even if they did not name the exact tool.
- `low`: the action loosely follows from the request but has unrequested side
  effects.
- `unknown`: little evidence that the user authorized the action.

## Static Preview Containers

Allow a `preview.container.createStaticSite` request only when:

- The source path is inside `/workspace`.
- Deterministic evidence shows the directory exists.
- `index.html` exists at the source root.
- The file count and byte size are within configured limits.
- No suspicious secret-like files are present.
- User authorization is at least `medium`.

Escalate to the user when the action might be appropriate but user
authorization is unclear. Deny invalid paths, missing source directories,
missing `index.html`, oversized sites, excessive traversal depth or directory
count, suspicious secret-like files, or any action that appears to expose
secrets.
