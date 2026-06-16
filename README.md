# Drafts MCP Server

MCP server for [Drafts](https://getdrafts.com) app integration, enabling Claude to interact with your Drafts notes via the Model Context Protocol.

## Features

- **Create drafts** - Create new drafts with content, tags, and optional actions
- **Get draft** - Retrieve specific draft by UUID
- **Get all drafts** - List all drafts with metadata (reads from local SQLite database)
- **Search drafts** - Text search (SQL `LIKE` over content and title) in local database
- **Append/Prepend** - Add text to existing drafts
- **Open draft** - Open draft in Drafts app
- **Run actions** - Execute Drafts actions on text
- **Search UI** - Open Drafts search interface with filters

## Requirements

- macOS (required for URL scheme integration and local database access)
- [Drafts app](https://getdrafts.com) installed
- Node.js 22+

## Installation

### 1. Install dependencies

```bash
npm install
```

### 2. Build the project

```bash
npm run build
```

### 3. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "drafts": {
      "command": "node",
      "args": ["/absolute/path/to/drafts-mcp/build/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/drafts-mcp` with the path where you cloned this repo.

### 4. Restart Claude Desktop

## Usage

Once configured, Claude can use the following tools:

### create_draft

Create a new draft:

```typescript
{
  text: "Draft content",
  tags?: ["tag1", "tag2"],
  action?: "Action Name",
  folder?: "inbox" | "archive"
}
```

### get_draft

Retrieve a draft by UUID:

```typescript
{
  uuid: "draft-uuid-here"
}
```

### get_all_drafts

Get list of all drafts with metadata by reading from local database:

```typescript
{
  folder?: "inbox" | "archive" | "trash" | "all",
  flagged?: boolean
}
```

Returns array of drafts with uuid, title, tags, timestamps, flags.

### search_drafts_db

Search drafts by text content in local database:

```typescript
{
  query: "search text"
}
```

Returns array of matching drafts.

### append_to_draft

Append text to existing draft:

```typescript
{
  uuid: "draft-uuid-here",
  text: "Text to append"
}
```

### prepend_to_draft

Prepend text to existing draft:

```typescript
{
  uuid: "draft-uuid-here",
  text: "Text to prepend"
}
```

### open_draft

Open draft in Drafts app:

```typescript
{
  uuid?: "draft-uuid-here",
  title?: "Draft Title"
}
```

### run_action

Execute a Drafts action:

```typescript
{
  action: "Action Name",
  text: "Text to process"
}
```

### search_drafts

Open Drafts search UI:

```typescript
{
  query?: "search query",
  tag?: "tag-name",
  folder?: "inbox" | "archive" | "flagged" | "trash" | "all"
}
```

## Resources

The server exposes draft content via resources:

- `draft://uuid/{uuid}` - Retrieve specific draft content

## Development

### Build

```bash
npm run build
```

### Watch mode

```bash
npm run watch
```

### Test

```bash
npm test
npm run test:watch
```

### Lint

```bash
npm run lint
npm run lint:fix
```

### Format

```bash
npm run format
npm run format:check
```

## Architecture

- **Callback Server** - Express server on a random loopback port (`127.0.0.1`) handling x-callback-url responses
- **Drafts Client** - URL scheme wrapper with retry logic (exponential backoff on the URL launch only — writes are never re-sent after a successful launch)
- **Drafts Database** - Direct read-only access to the Drafts SQLite database via `better-sqlite3` with bound parameters
- **MCP Server** - stdio transport, exposes tools and resources

## Security / Privacy

The server reads your local Drafts SQLite database in read-only mode. All database access is via bound SQL parameters (no string interpolation). The callback server binds exclusively to `127.0.0.1`. Nothing leaves your machine; there is no telemetry.

## Testing

Tests cover: callback server lifecycle and x-callback-url routing; URL building (correct scheme, endpoint, params, unique requestIds); retry logic (transient launch failures retry with exponential backoff; write idempotency: a successful launch is never re-sent even if Drafts returns an error); database queries (folder/flagged filters, search with bound parameters including SQL-special characters, result mapping).

## Limitations

- **macOS only** - Uses macOS `open` command for URL schemes and reads from the local Group Container
- **Drafts app required** - Must be running for write operations (create, append, prepend)
- **Read-only database** - Database queries are read-only; modifications go through URL schemes
- **UI for search** - `search_drafts` URL scheme opens UI (use `search_drafts_db` for programmatic search)
- **Tracks the Drafts schema** - The database reader queries Drafts' private Core Data SQLite schema (`ZMANAGEDDRAFT` and friends). This is stable across current Drafts versions but is not a public API and could change in a future Drafts release.
- **Hermetic tests** - The test suite verifies this server's own logic against mocked URL launches and a synthetic SQLite fixture; it does not drive a live Drafts install (Drafts can't run in CI). Integration with the real app is verified manually.

## Troubleshooting

### "Failed to open Drafts database"

- Ensure Drafts app is installed
- Check database path: `~/Library/Group Containers/GTFQ98J4YG.com.agiletortoise.Drafts/DraftStore.sqlite`
- Verify you have read permissions to the Group Container
- The database is opened read-only via `better-sqlite3`; the `sqlite3` CLI is not required

### "Request timed out"

- Ensure Drafts app is running
- Check Drafts has permission to receive URL schemes
- Verify callback server can bind to `127.0.0.1`

### "Connection failed"

- Restart Claude Desktop
- Check MCP server config path is correct
- Verify Node.js 22+ is installed

## License

MIT
