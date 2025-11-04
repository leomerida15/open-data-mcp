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
let mcpServer: Server;

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

        // Initialize the global MCP server instance
        mcpServer = initializeServer();

        console.log(
            `[MCP] OpenGov MCP Server configured for data portal: ${portalInfo.title}`,
        );
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
    console.log("[MCP] New SSE connection request received");
    
    try {
        // Create the SSE transport
        const transport = new SSEServerTransport("/mcp", res);
        
        // CRITICAL: Start the transport FIRST
        console.log("[MCP] Starting SSE transport...");
        await transport.start();
        console.log("[MCP] SSE transport started successfully");

        // Setup close handler after transport is started
        res.on("close", () => {
            console.log("[MCP] SSE connection closed by client");
            try {
                transport.close();
            } catch (closeError) {
                console.error("[MCP] Error closing transport:", closeError);
            }
        });

        // THEN connect the server to the transport
        console.log("[MCP] Connecting MCP server to transport...");
        await mcpServer.connect(transport);
        console.log("[MCP] MCP server connected successfully");
    } catch (error) {
        console.error("[MCP] Error handling SSE connection:", error);
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

// Handle POST messages
app.post("/mcp", async (req: Request, res: Response) => {
    console.log("[MCP] Received POST message");
    
    try {
        // Create a transport only for handling the POST message
        // No need to connect the server again, it's already connected via GET
        const transport = new SSEServerTransport("/mcp", res);
        
        console.log("[MCP] Processing POST message...");
        await transport.handlePostMessage(req, res, req.body);
        console.log("[MCP] POST message processed successfully");
    } catch (error) {
        console.error("[MCP] Error handling MCP POST request:", error);
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
