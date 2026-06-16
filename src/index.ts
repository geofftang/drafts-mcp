#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CallbackServer } from './callback-server.js';
import { DraftsClient } from './drafts-client.js';
import { DraftsDatabase } from './drafts-db.js';
import { z } from 'zod';

// Tool input schemas (Zod) — inputSchema for MCP derived via .toJSONSchema()
const CreateDraftSchema = z.object({
  text: z.string().describe('The content of the draft'),
  tags: z.array(z.string()).optional().describe('Tags to add to the draft'),
  action: z.string().optional().describe('Action to run on the draft after creation'),
  folder: z.enum(['inbox', 'archive']).optional().describe('Folder to place the draft in'),
});

const GetDraftSchema = z.object({
  uuid: z.string().describe('The UUID of the draft to retrieve'),
});

const AppendToDraftSchema = z.object({
  uuid: z.string().describe('The UUID of the draft'),
  text: z.string().describe('Text to append to the draft'),
});

const PrependToDraftSchema = z.object({
  uuid: z.string().describe('The UUID of the draft'),
  text: z.string().describe('Text to prepend to the draft'),
});

const OpenDraftSchema = z.object({
  uuid: z.string().optional().describe('The UUID of the draft to open'),
  title: z.string().optional().describe('The title of the draft to open'),
});

const RunActionSchema = z.object({
  action: z.string().describe('The name of the action to run'),
  text: z.string().describe('Text to run the action on'),
});

const SearchDraftsSchema = z.object({
  query: z.string().optional().describe('Search query'),
  tag: z.string().optional().describe('Filter by tag'),
  folder: z
    .enum(['inbox', 'archive', 'flagged', 'trash', 'all'])
    .optional()
    .describe('Filter by folder'),
});

const GetAllDraftsSchema = z.object({
  folder: z.enum(['inbox', 'archive', 'trash', 'all']).optional().describe('Filter by folder'),
  flagged: z.boolean().optional().describe('Filter by flagged status'),
});

const SearchDraftsDbSchema = z.object({
  query: z.string().describe('Search text in draft content and titles'),
});

// Tools registry — single source of truth for both ListTools and CallTool dispatch
const TOOLS = [
  {
    name: 'create_draft',
    description:
      'Create a new draft in Drafts app with the specified content, tags, and optional action',
    schema: CreateDraftSchema,
  },
  {
    name: 'get_draft',
    description: 'Retrieve a draft by its UUID',
    schema: GetDraftSchema,
  },
  {
    name: 'get_all_drafts',
    description: 'Get a list of all drafts with metadata by reading from local Drafts database',
    schema: GetAllDraftsSchema,
  },
  {
    name: 'search_drafts_db',
    description: 'Search drafts by text content in the local database',
    schema: SearchDraftsDbSchema,
  },
  {
    name: 'append_to_draft',
    description: 'Append text to an existing draft',
    schema: AppendToDraftSchema,
  },
  {
    name: 'prepend_to_draft',
    description: 'Prepend text to an existing draft',
    schema: PrependToDraftSchema,
  },
  {
    name: 'open_draft',
    description: 'Open a draft in the Drafts app by UUID or title',
    schema: OpenDraftSchema,
  },
  {
    name: 'run_action',
    description: 'Run a Drafts action on specified text',
    schema: RunActionSchema,
  },
  {
    name: 'search_drafts',
    description: 'Open the Drafts search interface with optional filters (opens UI)',
    schema: SearchDraftsSchema,
  },
] as const;

class DraftsMCPServer {
  private server: Server;
  private callbackServer: CallbackServer;
  private draftsClient: DraftsClient;
  private draftsDb: DraftsDatabase;

  constructor() {
    this.server = new Server(
      {
        name: 'drafts-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.callbackServer = new CallbackServer();
    this.draftsClient = new DraftsClient(this.callbackServer);
    this.draftsDb = new DraftsDatabase();

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    await this.callbackServer.stop();
  }

  private setupHandlers(): void {
    // List available tools — inputSchema derived from Zod schemas
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schema.toJSONSchema(),
      })),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'create_draft': {
            const args = CreateDraftSchema.parse(request.params.arguments);
            await this.draftsClient.createDraft(args);
            return {
              content: [{ type: 'text', text: 'Draft created successfully' }],
            };
          }

          case 'get_draft': {
            const args = GetDraftSchema.parse(request.params.arguments);
            const draft = await this.draftsClient.getDraft(args.uuid);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(draft, null, 2),
                },
              ],
            };
          }

          case 'get_all_drafts': {
            const args = GetAllDraftsSchema.parse(request.params.arguments);
            const drafts = this.draftsDb.getAllDrafts(args);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(drafts, null, 2),
                },
              ],
            };
          }

          case 'search_drafts_db': {
            const args = SearchDraftsDbSchema.parse(request.params.arguments);
            const drafts = this.draftsDb.searchDrafts(args.query);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(drafts, null, 2),
                },
              ],
            };
          }

          case 'append_to_draft': {
            const args = AppendToDraftSchema.parse(request.params.arguments);
            await this.draftsClient.appendToDraft(args.uuid, args.text);
            return {
              content: [{ type: 'text', text: 'Text appended successfully' }],
            };
          }

          case 'prepend_to_draft': {
            const args = PrependToDraftSchema.parse(request.params.arguments);
            await this.draftsClient.prependToDraft(args.uuid, args.text);
            return {
              content: [{ type: 'text', text: 'Text prepended successfully' }],
            };
          }

          case 'open_draft': {
            const args = OpenDraftSchema.parse(request.params.arguments);
            await this.draftsClient.openDraft(args);
            return {
              content: [{ type: 'text', text: 'Draft opened in Drafts app' }],
            };
          }

          case 'run_action': {
            const args = RunActionSchema.parse(request.params.arguments);
            await this.draftsClient.runAction(args.action, args.text);
            return {
              content: [{ type: 'text', text: 'Action executed successfully' }],
            };
          }

          case 'search_drafts': {
            const args = SearchDraftsSchema.parse(request.params.arguments);
            await this.draftsClient.searchDrafts(args);
            return {
              content: [{ type: 'text', text: 'Search opened in Drafts app' }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Invalid arguments: ${error.message}`);
        }
        throw error;
      }
    });

    // List static resources — drafts are addressed dynamically by UUID via the
    // resource template below, so there are no concrete resources to enumerate.
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));

    // List resource templates — a draft is read by substituting its UUID into
    // this URI template (the correct MCP modeling for parameterized resources).
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [
        {
          uriTemplate: 'draft://uuid/{uuid}',
          name: 'Draft by UUID',
          description: 'Retrieve a specific draft by its UUID',
          mimeType: 'application/json',
        },
      ],
    }));

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^draft:\/\/uuid\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const uuid = match[1];
      const draft = await this.draftsClient.getDraft(uuid);

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(draft, null, 2),
          },
        ],
      };
    });
  }

  async start(): Promise<void> {
    // Start callback server
    await this.callbackServer.start();

    // Start MCP server with stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Drafts MCP server running');
  }
}

// Start the server
const server = new DraftsMCPServer();
server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
