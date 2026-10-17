// The only Agent SDK values the plugin uses. sdk-loader requires this module
// instead of the SDK itself so esbuild still tree-shakes the SDK to these names.
export { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
