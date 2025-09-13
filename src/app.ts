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

// Create a new MCP server instance
function getServer(): Server {
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

            server.sendLoggingMessage({
                level: "error",
                data: {
                    message: `Error handling tool ${name}: ${errorMessage}`,
                    tool: name,
                    arguments: args,
                    timestamp: new Date().toISOString(),
                    error: errorMessage,
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

    return server;
}

// Setup server configuration
async function setupServer(): Promise<void> {
    try {
        // Get information about the data portal
        portalInfo = await getPortalInfo();

        // Update tools list with portal info
        enhancedTools = enhanceToolsWithPortalInfo(SOCRATA_TOOLS, portalInfo);

        console.log(
            `OpenGov MCP Server configured for data portal: ${portalInfo.title}`,
        );
    } catch (error) {
        console.error("Error during server setup:", error);
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
    try {
        const server = getServer();
        const transport = new SSEServerTransport("/mcp", res);

        res.on("close", () => {
            console.log("SSE connection closed");
            transport.close();
        });

        await server.connect(transport);
        await transport.start();
    } catch (error) {
        console.error("Error handling SSE connection:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                },
                id: null,
            });
        }
    }
});

// Handle POST messages
app.post("/mcp", async (req: Request, res: Response) => {
    try {
        const server = getServer();
        const transport = new SSEServerTransport("/mcp", res);

        await server.connect(transport);
        await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
        console.error("Error handling MCP POST request:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
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
const PORT = 3000;
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
