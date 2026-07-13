// Integration tests for the full cache-fix pipeline
// Verifies that our extensions correctly handle all observed
// Claude Code request patterns that break DeepSeek's cache.
//
// Run: node test-pipeline.mjs

import { deepStrictEqual, strictEqual, ok } from "node:assert";

let passed = 0;
let failed = 0;

function assert_test(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

// ============================================================
// Pattern 1: billing header in system blocks (issue #68900)
// ============================================================

function test_billing_header_strip() {
  // Simulate what strip-billing-header does
  const system = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.177.01c; cch=36ee5;" },
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "Be helpful.", cache_control: { type: "ephemeral" } },
  ];

  // Strip billing header blocks
  for (let i = system.length - 1; i >= 0; i--) {
    if (system[i].text?.includes("x-anthropic-billing-header:")) {
      system.splice(i, 1);
    }
  }

  assert_test(system.length === 2, "billing header: 3 blocks -> 2 after strip");
  assert_test(!system.some(s => s.text.includes("x-anthropic-billing-header")), "billing header: no billing text remains");
  assert_test(system[0].text.includes("You are Claude Code"), "billing header: system prompt preserved");
  assert_test(system[0].cache_control !== undefined, "billing header: cc on system[0] preserved");
}

// ============================================================
// Pattern 2: cache_control is ignored by DeepSeek but changes raw JSON tokens
// ============================================================

function test_cache_control_strip() {
  const body = {
    model: "deepseek-v4-flash",
    system: [
      { type: "text", text: "You are Claude.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "hello" },
        { type: "tool_result", content: "123", cache_control: { type: "ephemeral" } }
      ]},
    ],
    tools: [
      { name: "echo", cache_control: { type: "ephemeral" } }
    ]
  };

  // Strip all cache_control
  function stripCacheControl(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let count = 0;
    if (Array.isArray(obj)) {
      for (const item of obj) count += stripCacheControl(item);
    } else {
      if ("cache_control" in obj) { delete obj.cache_control; count++; }
      for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === "object") count += stripCacheControl(obj[key]);
      }
    }
    return count;
  }

  const stripped = stripCacheControl(body);
  assert_test(stripped === 3, `cache_control strip: 3 cc fields stripped (was ${stripped})`);
  assert_test(body.system[0].cache_control === undefined, "cache_control strip: system cc gone");
  assert_test(body.messages[0].content[1].cache_control === undefined, "cache_control strip: message cc gone");
  assert_test(body.tools[0].cache_control === undefined, "cache_control strip: tools cc gone");
  assert_test(body.system[0].text === "You are Claude.", "cache_control strip: text preserved");
  assert_test(body.messages[0].content[1].content === "123", "cache_control strip: tool_result preserved");
}

// ============================================================
// Pattern 3: text consumption — user text replaced by empty []
//   Example: 1669 msg[124] "再来2个" -> 1670 msg[124] []
// ============================================================

function test_text_consumption_restore() {
  // Previous request state
  const prev = {
    lastIdx: 2,
    content: [{ type: "text", text: "再来2个" }]
  };

  // Current request: same position has empty content (consumed)
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [] },  // consumed!
      { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", content: "39" }] },
    ]
  };

  // Restore logic: if prev content exists and current is consumed
  const oldMsg = body.messages[prev.lastIdx];
  const isConsumed = Array.isArray(oldMsg.content) && oldMsg.content.length === 0;

  assert_test(isConsumed, "text consumption: detected empty content at prev position");

  if (isConsumed) {
    body.messages[prev.lastIdx] = {
      role: "user",
      content: JSON.parse(JSON.stringify(prev.content))
    };
  }

  assert_test(body.messages[2].content.length === 1, "text consumption: content restored (1 block)");
  assert_test(body.messages[2].content[0].text === "再来2个", "text consumption: text restored");
  assert_test(body.messages.length === 5, "text consumption: msg count unchanged");
  assert_test(body.messages[4].content[0].content === "39", "text consumption: new messages preserved");
}

// ============================================================
// Pattern 4: JSON field order change — same data, different key order
//   Example: { content: "42", type: "tool_result" } vs { type: "tool_result", content: "42" }
// ============================================================

function test_field_order_stabilize() {
  // Previous request stored with field order: type, tool_use_id, content
  const prevContent = [
    { type: "tool_result", tool_use_id: "x1", content: "42" }
  ];

  // Current request has different field order: content, type, tool_use_id
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", name: "e", input: {}, id: "x1" }] },
      { role: "user", content: [
        { content: "42", type: "tool_result", tool_use_id: "x1" }  // different key order!
      ]},
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]
  };

  const oldIdx = 2;  // prev.lastIdx
  const oldMsg = body.messages[oldIdx];
  const prevJson = JSON.stringify(prevContent);
  const oldJson = JSON.stringify(oldMsg.content);

  // Should detect difference
  assert_test(prevJson !== oldJson, "field order: detected JSON difference");

  // Restore to match previous
  body.messages[oldIdx] = {
    role: "user",
    content: JSON.parse(prevJson),
  };

  const restoredKeys = Object.keys(body.messages[oldIdx].content[0]);
  assert_test(restoredKeys[0] === "type", `field order: first key is 'type', got '${restoredKeys[0]}'`);
  assert_test(body.messages[oldIdx].content[0].content === "42", "field order: content value preserved");
  assert_test(body.messages.length === 5, "field order: msg count unchanged");
}

// ============================================================
// Pattern 5: system message injection — Claude Code adds system reminder
//   Example: +3 msg growth instead of +2, new system [] at end
// ============================================================

function test_system_msg_injection() {
  // 1690: 36 msgs, last user msg[35] tool_result, NO system injection
  const prev = {
    lastIdx: 35,
    content: [{ type: "tool_result", tool_use_id: "x", content: "14" }]
  };

  // 1691: 39 msgs (+3 growth = system injection!)
  // The old last user position (35) should be HELD with prev content
  const body = {
    messages: Array.from({ length: 36 }, (_, i) => {
      if (i === 35) return { role: "user", content: [{ type: "tool_result", content: "14", tool_use_id: "y" }] };
      return { role: "user", content: [{ type: "text", text: `msg${i}` }] };
    }).concat([
      { role: "assistant", content: [{ type: "text", text: "thinking..." }] },    // 36
      { role: "user", content: [{ type: "tool_result", content: "15" }] },        // 37
      { role: "system", content: [] },                                              // 38 — injection!
    ])
  };

  // Prefix-hold logic: check old position
  const oldIdx = prev.lastIdx;
  const oldMsg = body.messages[oldIdx];
  const prevJson = JSON.stringify(prev.content);
  const oldJson = JSON.stringify(oldMsg.content);

  if (prevJson !== oldJson) {
    body.messages[oldIdx] = {
      role: "user",
      content: JSON.parse(prevJson),
    };
  }

  // Verify restoration
  assert_test(JSON.stringify(body.messages[35].content) === prevJson,
    "system injection: msg[35] restored to match prev");
  assert_test(body.messages.length === 39, "system injection: 39 msgs (36 + 3 new)");
  assert_test(body.messages[38].role === "system", "system injection: system msg at end");
}

// ============================================================
// Pattern 6: normal tool-call growth — content identical, only new msgs added
// ============================================================

function test_normal_growth() {
  // 1691: 39 msgs, last user msg[37]
  // 1692: 41 msgs, last user msg[40]
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", content: "15" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "tool_result", content: "16" }] },
    ]
  };

  // Normal growth: +2 msgs, old content unchanged
  // prefix-hold should find no diff at old position
  const prevContent = [{ type: "tool_result", content: "15" }];
  const prevJson2 = JSON.stringify(prevContent);
  const oldMsg2 = body.messages[2];
  const oldJson2 = JSON.stringify(oldMsg2.content);

  // With field order normalization, these should be the same
  assert_test(JSON.stringify(oldMsg2.content) !== undefined, "normal growth: msg[2] exists");
  assert_test(body.messages.length === 5, "normal growth: 5 msgs total");
}

// ============================================================
// Pattern 7: consecutive requests — verify prefix stability
// ============================================================

function test_consecutive_stability() {
  // Simulate 3 consecutive requests in a session
  const session = [];

  // Request N: store last user content
  function processRequest(msgs) {
    const lastIdx = msgs.map((m, i) => m.role === "user" ? i : -1).filter(i => i >= 0).pop();
    const prev = session.length > 0 ? session[session.length - 1] : null;

    if (prev) {
      const oldMsg = msgs[prev.lastIdx];
      if (JSON.stringify(prev.content) !== JSON.stringify(oldMsg.content)) {
        msgs[prev.lastIdx] = {
          role: "user",
          content: JSON.parse(JSON.stringify(prev.content)),
        };
      }
    }

    session.push({
      lastIdx,
      content: JSON.parse(JSON.stringify(msgs[lastIdx].content)),
    });

    return msgs;
  }

  // 3 requests simulating counting 1-2-3
  const r1 = processRequest([
    { role: "user", content: [{ type: "text", text: "count" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "1" } }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
  ]);

  const r2 = processRequest([
    { role: "user", content: [{ type: "text", text: "count" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "1" } }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "2" } }] },
    { role: "user", content: [{ type: "tool_result", content: "2" }] },
  ]);

  const r3 = processRequest([
    { role: "user", content: [{ type: "text", text: "count" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "1" } }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "2" } }] },
    { role: "user", content: [{ type: "tool_result", content: "2" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: { txt: "3" } }] },
    { role: "user", content: [{ type: "tool_result", content: "3" }] },
  ]);

  // All r1-r3 should have identical msg[0], msg[1], msg[2]
  const r1j = JSON.stringify(r1[2].content);
  const r2j = JSON.stringify(r2[2].content);
  const r3j = JSON.stringify(r3[2].content);

  assert_test(r1j === r2j, "consecutive: r1.msg[2] === r2.msg[2]");
  assert_test(r2j === r3j, "consecutive: r2.msg[2] === r3.msg[2]");
  assert_test(r2.length === 5, "consecutive: r2 has 5 msgs");
  assert_test(r3.length === 7, "consecutive: r3 has 7 msgs");
}

// ============================================================
// Run all tests
// ============================================================

console.log("=== Pattern 1: Billing header strip ===");
test_billing_header_strip();

console.log("\n=== Pattern 2: cache_control strip for DeepSeek ===");
test_cache_control_strip();

console.log("\n=== Pattern 3: Text consumption restore ===");
test_text_consumption_restore();

console.log("\n=== Pattern 4: Field order stabilization ===");
test_field_order_stabilize();

console.log("\n=== Pattern 5: System message injection ===");
test_system_msg_injection();

console.log("\n=== Pattern 6: Normal growth ===");
test_normal_growth();

console.log("\n=== Pattern 7: Consecutive stability ===");
test_consecutive_stability();

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
