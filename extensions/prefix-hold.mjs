// prefix-hold — hold user message content stable across consecutive requests
// to prevent Claude Code's text-consumption from breaking DeepSeek prefix cache.
//
// DeepSeek creates cache prefix units at the "end of user input". When Claude
// Code restructures the conversation (replacing a text message with empty [])
// the tokens at that position change and the prefix match breaks.
//
// This extension remembers the last-user-message content per session and
// restores it if Claude Code "consumed" it in a subsequent request, keeping
// the prefix stable without changing conversation semantics.
//
// order 46 — runs before cc-stripping and billing-header removal

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_PATH = join(LOG_DIR, "prefix-hold.log");

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] ph: ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

// In-memory state per Claude Code session and agent.
const state = new Map();

function sessionKey(ctx) {
  const sid = ctx?.headers?.["x-claude-code-session-id"]
    || ctx?.meta?._sessionId
    || null;
  if (!sid) return null;

  const agentId = ctx?.headers?.["x-claude-code-agent-id"]
    || ctx?.meta?._agentId
    || "main";
  return `${sid}:${agentId}`;
}

function cloneUserMsg(msg) {
  if (!msg || !Array.isArray(msg.content)) return null;
  return JSON.parse(JSON.stringify({ role: msg.role, content: msg.content }));
}

// Find the index of the LAST user message in the array
function lastUserMsgIdx(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

// Check if a user message has text content (and extract it)
function hasTextContent(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0
  );
}

// Deep-clone a message's content array for storage
function freezeContent(msg) {
  if (!msg || !Array.isArray(msg.content)) return null;
  return JSON.parse(JSON.stringify(msg.content));
}

function toolResultIds(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id)
    .filter((id) => typeof id === "string");
}

function canRestoreContent(prevContent, currentContent) {
  const prevIds = toolResultIds(prevContent);
  const currentIds = toolResultIds(currentContent);
  if (prevIds.length === 0 && currentIds.length === 0) return true;
  return JSON.stringify(prevIds) === JSON.stringify(currentIds);
}

function isConsumed(msg) {
  if (!msg || !msg.content) return false;
  // Empty array or array with zero-length strings only = consumed
  if (Array.isArray(msg.content)) {
    if (msg.content.length === 0) return true;
    // Single block with empty text
    if (msg.content.length === 1 && msg.content[0].text === "") return true;
  }
  return false;
}

function isTextUser(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.length > 0 && msg.content.some(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0
  );
}

export default {
  name: "prefix-hold",
  description:
    "Hold user text content stable across requests to prevent Claude Code " +
    "text-consumption from breaking DeepSeek prefix-cache matching",
  order: 46,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!Array.isArray(body?.messages)) return;

    const sid = sessionKey(ctx);
    if (!sid || sid.length === 0) {
      log("no session id, skip");
      return;
    }

    const msgs = body.messages;
    const lastIdx = lastUserMsgIdx(msgs);
    if (lastIdx < 0) {
      log(`sid=${sid} no user msg found`);
      return;
    }

    const prev = state.get(sid);
    const currentMsg = msgs[lastIdx];
    const currentContent = currentMsg?.content;

    if (!prev) {
      // First request for this session: store the last user message
      state.set(sid, {
        lastIdx,
        content: freezeContent(currentMsg),
        at: new Date().toISOString(),
      });
      log(`sid=${sid} first: last_idx=${lastIdx} content_blocks=${currentContent?.length ?? 0}`);
      return;
    }

    // We have previous state. Compare.
    const prevContent = prev.content;

    // Case 1: last user msg position moved forward (normal conversation growth)
    if (lastIdx > prev.lastIdx) {
      // Check if the OLD position's content changed
      if (lastIdx - prev.lastIdx <= 4) {
        const oldMsg = msgs[prev.lastIdx];
        const prevJson = JSON.stringify(prevContent);
        const oldJson = JSON.stringify(oldMsg?.content);

        if (prevJson !== oldJson) {
          // Content at old position changed — always restore previous content
          // to keep prefix bytes stable for DeepSeek's cache matching.
          // This covers: text consumption, field-order changes, and any
          // other variation Claude Code introduces between requests.
          if (prevContent && canRestoreContent(prevContent, oldMsg?.content)) {
            msgs[prev.lastIdx] = {
              role: "user",
              content: JSON.parse(prevJson),
            };
            log(
              `sid=${sid} HELD msg[${prev.lastIdx}]: ` +
              `prev_blocks=${prevContent?.length ?? 0} now_blocks=${oldMsg?.content?.length ?? 0}`
            );
          } else if (prevContent) {
            log(`sid=${sid} SKIP msg[${prev.lastIdx}]: tool_result ids changed`);
          }
        }
      }

      // Update state with new last user msg
      state.set(sid, {
        lastIdx,
        content: freezeContent(currentMsg),
        at: new Date().toISOString(),
      });
      log(
        `sid=${sid} grew: prev_idx=${prev.lastIdx} -> ${lastIdx} ` +
        `content_blocks=${currentContent?.length ?? 0}`
      );
      return;
    }

    // Case 2: last user msg at same position (shouldn't happen normally)
    if (lastIdx === prev.lastIdx) {
      const currJson = JSON.stringify(currentContent);
      const prevJson = JSON.stringify(prevContent);

      if (currJson !== prevJson && prevContent && canRestoreContent(prevContent, currentContent)) {
        msgs[lastIdx] = {
          role: "user",
          content: JSON.parse(prevJson),
        };
        log(`sid=${sid} HELD msg[${lastIdx}]: stayed, content restored from prev`);
        // Keep prev state (don't update — content should stay stable)
      } else {
        if (currJson !== prevJson && prevContent) {
          log(`sid=${sid} SKIP msg[${lastIdx}]: tool_result ids changed`);
        }
        state.set(sid, {
          lastIdx,
          content: freezeContent(currentMsg),
          at: new Date().toISOString(),
        });
      }
      return;
    }

    // Case 3: last user msg moved backward (compacting? unexpected)
    log(`sid=${sid} UNEXPECTED: lastIdx ${prev.lastIdx} -> ${lastIdx}`);
    state.set(sid, {
      lastIdx,
      content: freezeContent(currentMsg),
      at: new Date().toISOString(),
    });
  },
};
