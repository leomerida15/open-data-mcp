import cors from "cors";
import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";

// Import Socrata unified tool
import { handleSocrataTool, SOCRATA_TOOLS } from "./tools/socrata-tools.js";
import { getPortalInfo, PortalInfo } from "./utils/portal-info.js";

// Global variables for server state
let portalInfo: PortalInfo;
let enhancedTools: Tool[];

// Map to store active SSE transports by session ID
const activeTransports = new Map<string, SSEServerTransport>();

// Map to store active MCP servers by session ID
const activeServers = new Map<string, Server>();

// Enhanced tool with portal context
function enhanceToolsWithPortalInfo(
    tools: Tool[],
    portalInfo: PortalInfo,
): Tool[] {
    return tools.map((tool) => {
        // Create a copy of the tool
        const enhancedTool: Tool = { ...tool };

        // Add portal info to the description
        enhancedTool.description = `[${portalInfo.title}] ${tool.description}`;

        return enhancedTool;
    });
}

// Initialize a single MCP server instance
function initializeServer(): Server {
    console.log("[MCP] Initializing MCP server instance");
    
    const server = new Server(
        {
            name: "opengov-mcp",
            version: "0.1.0",
        },
        {
            capabilities: {
                tools: {},
                logging: {},
            },
        },
    );

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            server.sendLoggingMessage({
                level: "info",
                data: {
                    message: `Handling tool call: ${name}`,
                    tool: name,
                    arguments: args,
                    timestamp: new Date().toISOString(),
                },
            });

            let result: unknown;

            if (name === "get_data") {
                // Handle the unified data retrieval tool
                result = await handleSocrataTool(args || {});
            } else {
                throw new Error(`Unknown tool: ${name}`);
            }

            // Log success
            server.sendLoggingMessage({
                level: "info",
                data: {
                    message: `Successfully executed tool: ${name}`,
                    tool: name,
                    resultSize: JSON.stringify(result).length,
                    timestamp: new Date().toISOString(),
                },
            });

            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                isError: false,
            };
        } catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;

            server.sendLoggingMessage({
                level: "error",
                data: {
                    message: `Error handling tool ${name}: ${errorMessage}`,
                    tool: name,
                    arguments: args,
                    timestamp: new Date().toISOString(),
                    error: errorMessage,
                    stack: errorStack,
                },
            });

            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
                isError: true,
            };
        }
    });

    // Update the tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: enhancedTools,
    }));

    console.log("[MCP] Server instance initialized successfully");
    return server;
}

// Setup server configuration
async function setupServer(): Promise<void> {
    try {
        console.log("[MCP] Starting server setup...");
        
        // Get information about the data portal
        portalInfo = await getPortalInfo();
        console.log(`[MCP] Portal info retrieved: ${portalInfo.title}`);

        // Update tools list with portal info
        enhancedTools = enhanceToolsWithPortalInfo(SOCRATA_TOOLS, portalInfo);
        console.log(`[MCP] Enhanced ${enhancedTools.length} tool(s) with portal info`);

        console.log(
            `[MCP] OpenGov MCP Server configured for data portal: ${portalInfo.title}`,
        );
        console.log("[MCP] Ready to accept SSE connections. Each connection will get its own server instance.");
    } catch (error) {
        console.error("[MCP] Error during server setup:", error);
        if (error instanceof Error) {
            console.error("[MCP] Stack trace:", error.stack);
        }
        throw error;
    }
}

const app = express();

// Add CORS middleware before your MCP routes
app.use(cors({
    origin: "*", // Configure appropriately for production, for example:
    // origin: ['https://your-remote-domain.com', 'https://your-other-remote-domain.com'],
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: ["Content-Type", "mcp-session-id"],
}));
app.use(express.json());

// Handle SSE connection (GET request)
app.get("/mcp", async (req: Request, res: Response) => {
    // Generate a unique session ID for this SSE connection
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    console.log(`[MCP] New SSE connection request received (Session: ${sessionId})`);
    
    try {
        // Create a NEW MCP server instance for THIS session
        console.log(`[MCP] Creating new MCP server instance for session ${sessionId}`);
        const server = initializeServer();
        
        // Create the SSE transport
        const transport = new SSEServerTransport("/mcp", res);
        
        // Store BOTH the transport AND the server in the maps
        activeTransports.set(sessionId, transport);
        activeServers.set(sessionId, server);
        console.log(`[MCP] Transport and server stored for session ${sessionId}`);
        
        // Setup close handler to clean up when connection closes
        res.on("close", () => {
            console.log(`[MCP] SSE connection closed by client (Session: ${sessionId})`);
            
            // Remove from active maps
            activeTransports.delete(sessionId);
            activeServers.delete(sessionId);
            console.log(`[MCP] Session ${sessionId} removed from active sessions`);
            
            try {
                transport.close();
            } catch (closeError) {
                console.error(`[MCP] Error closing transport for session ${sessionId}:`, closeError);
            }
        });

        // Set the session ID in the response header so the client can use it for POST requests
        res.setHeader("Mcp-Session-Id", sessionId);
        
        // Connect THIS server to THIS transport
        // NOTE: server.connect() automatically calls transport.start() internally
        console.log(`[MCP] Connecting MCP server to transport (Session: ${sessionId})...`);
        await server.connect(transport);
        console.log(`[MCP] MCP server connected and transport started successfully (Session: ${sessionId})`);
        console.log(`[MCP] Active sessions: ${activeTransports.size}`);
    } catch (error) {
        console.error(`[MCP] Error handling SSE connection (Session: ${sessionId}):`, error);
        if (error instanceof Error) {
            console.error("[MCP] Error stack:", error.stack);
        }
        
        // Clean up on error
        activeTransports.delete(sessionId);
        activeServers.delete(sessionId);
        
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                    data: error instanceof Error ? error.message : String(error),
                },
                id: null,
            });
        }
    }
});

// Handle POST messages
app.post("/mcp", async (req: Request, res: Response) => {
    // Get the session ID from the request header
    const sessionId = req.headers["mcp-session-id"] as string;
    
    console.log(`[MCP] Received POST message (Session: ${sessionId || "unknown"})`);
    console.log(`[MCP] Active sessions: ${activeTransports.size}`);
    console.log(`[MCP] Available session IDs: ${Array.from(activeTransports.keys()).join(", ")}`);
    
    try {
        // Retrieve the transport for this session
        const transport = activeTransports.get(sessionId);
        
        if (!transport) {
            console.error(`[MCP] No active transport found for session: ${sessionId}`);
            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Session not found. Please establish SSE connection first (GET /mcp)",
                },
                id: null,
            });
            return;
        }
        
        console.log(`[MCP] Found transport for session ${sessionId}, processing message...`);
        await transport.handlePostMessage(req, res, req.body);
        console.log(`[MCP] POST message processed successfully for session ${sessionId}`);
    } catch (error) {
        console.error(`[MCP] Error handling MCP POST request (Session: ${sessionId}):`, error);
        if (error instanceof Error) {
            console.error("[MCP] Error stack:", error.stack);
        }
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                    data: error instanceof Error ? error.message : String(error),
                },
                id: null,
            });
        }
    }
});

// Handle DELETE requests (session termination)
app.delete("/mcp", async (req: Request, res: Response) => {
    console.log("Received DELETE MCP request");
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "Method not allowed.",
        },
        id: null,
    }));
});

// Start the server
const PORT = +(process.env.PORT || 9090);
setupServer().then(() => {
    app.listen(PORT, (error) => {
        if (error) {
            console.error("Failed to start server:", error);
            process.exit(1);
        }
        console.log(
            `MCP Stateless Streamable HTTP Server listening on port ${PORT}`,
        );
    });
}).catch((error) => {
    console.error("Failed to set up the server:", error);
    process.exit(1);
});
