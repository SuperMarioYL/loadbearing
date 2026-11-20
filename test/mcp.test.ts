import { describe, it } from "vitest";

// TODO(m3): start `loadbearing mcp` over stdio with the SDK client and assert the
// CallToolResult envelope — `content[0].text` carries loadbearing/report@1 JSON,
// `isError` is absent or false — and that a bad `base` returns isError: true.
describe.skip("mcp tool: loadbearing_check", () => {
  it("returns the report as a CallToolResult content block", () => {
    // Filled in when src/mcp.ts lands.
  });
});
