/**
 * update-docs.mjs
 *
 * Called by the release-docs CI workflow after a new version is published.
 * Reads the source diff between releases, compares it against the current
 * SDK prose docs, and uses Claude to update any pages that need changing.
 *
 * Usage:
 *   node scripts/update-docs.mjs <diff-file> <prev-tag> <new-tag> <docs-repo-path>
 *
 * Exit codes:
 *   0 — completed (files may or may not have changed; check git diff)
 *   1 — error
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const [, , diffFile, prevTag, newTag, docsRepoPath = "../docs-repo"] = process.argv;

if (!diffFile || !prevTag || !newTag) {
  console.error("Usage: node update-docs.mjs <diff-file> <prev-tag> <new-tag> [docs-repo-path]");
  process.exit(1);
}

const diff = existsSync(diffFile)
  ? readFileSync(diffFile, "utf-8").trim()
  : "(no diff available — likely the initial release)";

const PROSE_PAGES = ["sdk/introduction.mdx", "sdk/quickstart.mdx", "sdk/configuration.mdx"];

const currentDocs = PROSE_PAGES
  .filter((p) => existsSync(join(docsRepoPath, p)))
  .map((p) => ({ path: p, content: readFileSync(join(docsRepoPath, p), "utf-8") }));

if (currentDocs.length === 0) {
  console.log("No SDK prose pages found in docs repo — nothing to update.");
  process.exit(0);
}

console.log(`Comparing ${prevTag} → ${newTag} (${diff.split("\n").length} diff lines)`);
console.log(`Reviewing ${currentDocs.length} prose pages...`);

const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 16000,
  tools: [
    {
      name: "update_doc_file",
      description: "Update a documentation page with revised content.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the file to update (e.g. sdk/quickstart.mdx).",
          },
          content: {
            type: "string",
            description: "Complete updated file content, preserving Mintlify MDX format.",
          },
          reason: {
            type: "string",
            description: "One sentence explaining what changed and why.",
          },
        },
        required: ["path", "content", "reason"],
      },
    },
    {
      name: "no_changes_needed",
      description: "Signal that no prose doc updates are required for this release.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
      },
    },
  ],
  messages: [
    {
      role: "user",
      content: `You are reviewing the @payai/agentic-payments SDK documentation after a new release (${prevTag} → ${newTag}).

Your job: read the source diff and the current docs, then call update_doc_file for each prose page that needs updating, or no_changes_needed if nothing needs to change.

Guidelines:
- Only update pages where the release diff makes the existing content wrong, incomplete, or misleading.
- Do not make stylistic changes or add content that wasn't necessitated by the diff.
- Preserve Mintlify MDX format exactly: frontmatter, Card/CardGroup components, import statements, tip/note/warning callouts.
- The package name is @payai/agentic-payments.
- Keep descriptions accurate and concise — do not pad with marketing language.

SOURCE DIFF (${prevTag} → ${newTag}):
\`\`\`diff
${diff}
\`\`\`

CURRENT DOCUMENTATION:
${currentDocs.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n")}`,
    },
  ],
});

let updatedCount = 0;

for (const block of response.content) {
  if (block.type !== "tool_use") continue;

  if (block.name === "no_changes_needed") {
    console.log(`No changes needed: ${block.input.reason}`);
    continue;
  }

  if (block.name === "update_doc_file") {
    const { path, content, reason } = block.input;
    const fullPath = join(docsRepoPath, path);
    if (!existsSync(fullPath)) {
      console.warn(`Skipping unknown path: ${path}`);
      continue;
    }
    writeFileSync(fullPath, content, "utf-8");
    console.log(`Updated ${path}: ${reason}`);
    updatedCount++;
  }
}

console.log(`Done. ${updatedCount} file(s) updated.`);
