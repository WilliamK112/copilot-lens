import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import { runInNewContext } from "vm";
import ts from "typescript";

const source = readFileSync(path.resolve("public/app.js"), "utf8");
const ast = ts.createSourceFile(
  "app.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const names = [
  "csvCell",
  "getSessionCsvModel",
  "buildSessionsCsv",
  "loadSessionCsvDetails",
  "exportFilteredSessions",
];
const code = ast.statements
  .filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      !!node.name &&
      names.includes(node.name.text)
  )
  .map((node) => node.getText(ast))
  .join("\n");

function context(overrides: Record<string, unknown> = {}) {
  return {
    Blob,
    encodeURIComponent,
    setTimeout: (callback: () => void) => callback(),
    ...overrides,
  };
}

describe("filtered session CSV export", () => {
  it("builds the requested columns from real session-detail fields", () => {
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv([session])`,
      context({
        session: {
          id: "session-1",
          createdAt: "2026-10-21T01:02:03.000Z",
          source: "claude-code",
          status: "completed",
          duration: 90_000,
          cwd: "/workspace/project",
          eventCounts: { "tool.execution_start": 2 },
          events: [
            { type: "session.start", data: { model: "claude-sonnet" } },
            { type: "session.model_change", data: { newModel: "claude-opus" } },
          ],
        },
      })
    );
    expect(csv).toBe(
      '"Date","Source","Model","Status","Duration (min)","Tool Count","Directory"\r\n' +
        '"2026-10-21T01:02:03.000Z","claude-code","claude-opus","completed","1.50","2","/workspace/project"\r\n'
    );
  });

  it("quotes CSV metacharacters and neutralizes spreadsheet formulas", () => {
    const csv = runInNewContext(
      `${code}\nbuildSessionsCsv([session])`,
      context({
        session: {
          createdAt: "2026-10-21",
          source: "cli",
          status: "completed",
          duration: 0,
          cwd: '=HYPERLINK("https://example.test","click")\nfolder',
          events: [],
        },
      })
    );
    expect(csv).toContain(
      '"\'=HYPERLINK(""https://example.test"",""click"")\nfolder"'
    );
  });

  it("downloads only the filtered rows and revokes the object URL", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    const button = { disabled: false };
    const status = { hidden: false, textContent: "old" };
    const link = { href: "", download: "", hidden: false, click, remove };
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        id: url.endsWith("keep") ? "keep" : "unexpected",
        createdAt: "2026-10-21T00:00:00Z",
        source: "vscode",
        status: "completed",
        duration: 60_000,
        cwd: "/kept",
        eventCounts: { "tool.execution_start": 1 },
        events: [],
      }),
    }));
    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch,
        isSearchActive: false,
        searchResultSessions: [],
        getFilteredSessions: () => [{ id: "keep" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
          createElement: () => link,
          body: { appendChild },
        },
        URL: { createObjectURL, revokeObjectURL },
      })
    );
    expect(fetch).toHaveBeenCalledWith("/api/sessions/keep");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(link.download).toBe("sessions-filtered.csv");
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    expect(button.disabled).toBe(false);
    expect(status.hidden).toBe(true);
  });

  it("exports the visible full-text search results instead of metadata matches", async () => {
    const fetched: string[] = [];
    const button = { disabled: false };
    const status = { hidden: false, textContent: "" };
    await runInNewContext(
      `${code}\nexportFilteredSessions()`,
      context({
        fetch: vi.fn(async (url: string) => {
          fetched.push(url);
          return { ok: false };
        }),
        isSearchActive: true,
        searchResultSessions: [{ id: "full-text-hit" }],
        getFilteredSessions: () => [{ id: "metadata-hit" }],
        document: {
          getElementById: (id: string) =>
            id === "exportSessionsCsvBtn" ? button : status,
          createElement: () => ({
            href: "",
            download: "",
            hidden: false,
            click: vi.fn(),
            remove: vi.fn(),
          }),
          body: { appendChild: vi.fn() },
        },
        URL: { createObjectURL: () => "blob:csv", revokeObjectURL: vi.fn() },
      })
    );
    expect(fetched).toEqual(["/api/sessions/full-text-hit"]);
  });
});
