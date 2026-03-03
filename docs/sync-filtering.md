# Sync Filtering (Entity + Label)

This adapter can filter Home Assistant entities before creating objects in ioBroker.

## Available config fields

- `whitelist` (regex list, optional)
- `blacklist` (regex list, optional)
- `labelWhitelist` (regex list, optional)
- `labelBlacklist` (regex list, optional)
- `labelWhitelistOverridesBlacklist` (boolean, default: `true`)
- `exposeAllEntitiesJson` (boolean, default: `false`)

Regex lists can be entered line-by-line, comma-separated, or semicolon-separated.

## Filter behavior

Whitelist logic is OR-based:

- An entity is allowed if at least one whitelist matches:
  - `whitelist` matches `entity_id`, or
  - `labelWhitelist` matches one of the entity labels.
- If both whitelists are empty, all entities are whitelist-allowed.

Blacklist logic:

- `blacklist` and `labelBlacklist` are OR-based (any match blocks the entity).

Override behavior:

- If `labelWhitelistOverridesBlacklist=true` and an entity matches `labelWhitelist`,
  blacklists are ignored for that entity.

## Label source

Label filtering uses Home Assistant websocket registry APIs:

- `config/entity_registry/list`
- `config/label_registry/list`

The adapter matches both label IDs and label names.

## Sync + cleanup behavior

- Filtered entities are not created in `hass.X.entities.*`.
- Entities that were synced before but are no longer allowed are removed on next sync.
- After removal, iterative cleanup deletes empty containers/channels under `entities.*`.

## Optional helper state

If `exposeAllEntitiesJson=true`, the adapter creates:

- `hass.X.host.all_entities`

This state contains a JSON array of all Home Assistant `entity_id` values (unfiltered),
to help build whitelist/blacklist rules.
