/**
 * src/tools/research.ts
 *
 * Native research tools for the inner agent.
 *
 * These replace the previous external MCP servers (fetch, tavily, and eventually
 * context7 / muonroi-docs) so that web/docs lookup and search are:
 * - Always available without spawn / warmup / "Connection closed"
 * - Subject to the same permission, capping, redaction and cost rules as other builtins
 * - Fast and reliable on first turn
 *
 * memory and playwright were removed from defaults (see auto-setup.ts).
 * Full browser automation (playwright) can still be added manually if needed.
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import TurndownService from "turndown";
import { getMcpKey } from "../mcp/mcp-keychain.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Basic cleanup for HTML before turndown (remove scripts, styles, etc.)
function sanitizeForMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : undefined;
}

export interface FetchUrlOptions {
  format?: "markdown" | "text" | "html";
  /** Max characters to return (soft cap) */
  maxChars?: number;
}

export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<string> {
  const { format = "markdown", maxChars = 12000 } = opts;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "muonroi-cli/1.0 (+https://github.com/muonroi/muonroi-cli)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return `ERROR fetch_failed: HTTP ${res.status} ${res.statusText} for ${url}`;
    }

    const contentType = res.headers.get("content-type") || "";
    let body = await res.text();

    if (format === "html") {
      return body.length > maxChars ? body.slice(0, maxChars) + "\n... [truncated]" : body;
    }

    if (contentType.includes("application/json")) {
      try {
        const obj = JSON.parse(body);
        body = JSON.stringify(obj, null, 2);
      } catch {}
      return body.length > maxChars ? body.slice(0, maxChars) + "\n... [truncated]" : body;
    }

    // Treat as HTML or plain text
    const isHtml = /<\/?[a-z][\s\S]*>/i.test(body) || contentType.includes("html");

    if (format === "text") {
      // Very lightweight text extraction
      const text = isHtml
        ? body
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : body;
      return text.length > maxChars ? text.slice(0, maxChars) + "\n... [truncated]" : text;
    }

    // markdown (default)
    if (isHtml) {
      const cleaned = sanitizeForMarkdown(body);
      const title = extractTitle(body);
      let md = turndown.turndown(cleaned);
      if (title && !md.startsWith("# ")) {
        md = `# ${title}\n\n${md}`;
      }
      if (md.length > maxChars) {
        md = md.slice(0, maxChars) + "\n\n... [truncated — use more specific URL or smaller scope]";
      }
      // Add source
      return `${md}\n\n_Source: ${url}_`;
    }

    // Plain text → code block or just return
    const out = body.length > maxChars ? body.slice(0, maxChars) + "\n... [truncated]" : body;
    return `\`\`\`\n${out}\n\`\`\`\n\n_Source: ${url}_`;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return `ERROR fetch_timeout: timed out after 15s fetching ${url}`;
    }
    return `ERROR fetch_error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timeout);
  }
}

export interface WebSearchOptions {
  maxResults?: number;
  /** Optional override; otherwise loaded from keychain or TAVILY_API_KEY */
  apiKey?: string;
}

export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<string> {
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 8, 20));

  let key = opts.apiKey;
  if (!key) {
    key = (await getMcpKey("tavily")) || process.env.TAVILY_API_KEY || "";
  }

  if (!key || key.length < 10) {
    return (
      "ERROR no_tavily_key: Tavily API key is required for web_search. " +
      "Run `muonroi-cli mcp setup-research` or set TAVILY_API_KEY. " +
      "You can also use `fetch_url` for direct URLs."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        search_depth: "basic",
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `ERROR tavily_http_${res.status}: ${text.slice(0, 300)}`;
    }

    const data: any = await res.json();

    const lines: string[] = [];

    if (data.answer) {
      lines.push("**Answer summary:**");
      lines.push(data.answer);
      lines.push("");
    }

    const results = Array.isArray(data.results) ? data.results : [];

    if (results.length === 0) {
      return "No web results found.";
    }

    lines.push(`**Web results** (top ${Math.min(results.length, maxResults)}):\n`);

    for (const r of results.slice(0, maxResults)) {
      const title = r.title || r.url;
      const url = r.url;
      const content = (r.content || r.raw_content || "").trim().slice(0, 600);
      lines.push(`- **${title}**`);
      lines.push(`  ${url}`);
      if (content) lines.push(`  ${content.replace(/\s+/g, " ")}`);
      lines.push("");
    }

    if (data.query) {
      lines.push(`_Query: ${data.query}_`);
    }

    return lines.join("\n");
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return "ERROR web_search_timeout: Tavily request timed out.";
    }
    return `ERROR web_search_failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timeout);
  }
}

/** Register the native research tools into the provided ToolSet. */
export function registerNativeResearchTools(tools: ToolSet): ToolSet {
  tools.fetch_url = dynamicTool({
    description:
      "Fetch a URL and return clean, readable content as markdown (default), plain text, or raw HTML. " +
      "Ideal for documentation, articles, GitHub, blog posts, raw files, and any public web page. " +
      "Use this for most 'read this URL' needs instead of external MCP fetch.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        url: { type: "string", description: "The full http(s) URL to fetch" },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Output format. Default: markdown (best for agents)",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return (500-30000). Default ~12000.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const url = String(input?.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        return "ERROR invalid_url: fetch_url requires a full http(s):// URL";
      }
      const format = (["markdown", "text", "html"].includes(input?.format) ? input.format : "markdown") as any;
      const maxChars = typeof input?.maxChars === "number" ? input.maxChars : undefined;
      return fetchUrl(url, { format, maxChars });
    },
  });

  tools.web_search = dynamicTool({
    description:
      "Search the live web using Tavily (LLM-optimized search with summaries). " +
      "Returns titles, URLs, and content snippets. Requires a Tavily API key (free tier available). " +
      "Use together with fetch_url when you need deeper content from specific results.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (natural language is fine)" },
        maxResults: {
          type: "number",
          description: "How many results to return (1-20). Default 8.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const query = String(input?.query || "").trim();
      if (!query) return "ERROR invalid_query: web_search requires a non-empty query";
      const maxResults = typeof input?.maxResults === "number" ? input.maxResults : undefined;
      return webSearch(query, { maxResults });
    },
  });

  return tools;
}
