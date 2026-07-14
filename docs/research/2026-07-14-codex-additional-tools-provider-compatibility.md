# Codex `additional_tools` Provider Compatibility

Research date: 2026-07-14

## Conclusion

The observed behavior is a provider compatibility difference, not an API-key
difference and not a cache-fix extension failure.

Codex Desktop sent its callable tools as an OpenAI Responses input item:

```json
{
  "type": "additional_tools",
  "role": "developer",
  "tools": [
    { "name": "exec", "...": "..." },
    { "name": "wait", "...": "..." },
    { "name": "request_user_input", "...": "..." },
    { "name": "collaboration", "...": "..." }
  ]
}
```

It did not send a top-level `tools` array. `codex-cubence` interpreted the
`additional_tools` item and returned a `custom_tool_call`. `codex-oaifree`
accepted the request with HTTP 200 but returned only reasoning and a message,
so Codex had no tool call to execute.

## Local Evidence

### Channel configuration

AxonHub channels:

| ID | Name | Type | Base URL |
|---:|---|---|---|
| 5 | `codex-cubence` | `codex` | `https://api.cubence.com/v1` |
| 10 | `codex-oaifree` | `codex` | `https://hub.oaifree.com` |

Their relevant AxonHub settings are equal:

- `policies.stream = unlimited`;
- no model mappings or parameter/header overrides;
- `forceArrayInstructions = false`;
- `forceArrayInputs = false`;
- `replaceDeveloperRoleWithSystem = false`;
- environment proxy mode.

The only non-secret inventory difference is that Cubence has a manually saved
model list while oaifree uses its synchronized supported-model list. Both
include `gpt-5.6-sol`.

### Forwarded request bodies

AxonHub `request_executions` records prove what was actually sent upstream:

| Request | Execution | Channel | Top-level tools | `additional_tools` | Tool payload SHA-256 |
|---:|---:|---:|---:|---:|---|
| 2865 | 3052 | 5 (`codex-cubence`) | 0 | 4 | `b80441fcb4d9ab8fdf6086d633f901435289d229dabb10870ce8c4b515e15e22` |
| 2879 | 3066 | 10 (`codex-oaifree`) | 0 | 4 | `b80441fcb4d9ab8fdf6086d633f901435289d229dabb10870ce8c4b515e15e22` |

The tool names, definitions, order, role, and serialized payload hash are
identical. AxonHub did not remove the tool item for oaifree.

### Different upstream outcomes

| Request | Channel | Response output types | Outcome |
|---:|---|---|---|
| 2865 | `codex-cubence` | `reasoning`, `message`, `custom_tool_call` | called `exec` |
| 2879 | `codex-oaifree` | `reasoning`, `message` | no tool call |

Request 2879 corresponds to the 2026-07-14 02:04 UTC turn where the assistant
reported that no executable tools were available. The request completed with
HTTP 200, so ordinary availability and health checks could not detect this
semantic incompatibility.

### A separate Cubence incompatibility

CC Switch logs also show that direct Codex requests to Cubence later rejected
historical Responses items whose IDs began with `item_`, requiring IDs beginning
with `msg` instead. This is a separate issue, but it confirms that third-party
Responses implementations apply provider-specific schema rules even when their
Codex configurations look identical.

## Official API Context

The current OpenAI Responses create reference documents an input item whose
type is always `additional_tools`:

- [Create a model response](https://developers.openai.com/api/docs/api-reference/responses/create)

The current Codex manual says a custom model provider defines its base URL,
wire API, authentication, and headers, and that Codex can target providers that
support the Responses API:

- [Codex configuration](https://developers.openai.com/codex/config-advanced)
- [Codex models](https://developers.openai.com/codex/models)

However, the public `openai/openai-openapi` YAML snapshot did not contain the
`additional_tools` token at research time. That mismatch makes it plausible
for compatible-looking gateways to implement the common Responses fields but
lag on this newer input-item variant.

## Why Claude Code Can Still Work

Claude Code uses Anthropic `/v1/messages` and sends tools in the standard
Anthropic `tools` array. Codex Desktop uses OpenAI `/v1/responses` and, in this
observed build, sends tool availability through `input[].additional_tools`.
Success in Claude Code therefore does not test the protocol path that failed in
Codex.

## Recommended Handling

1. Track provider compatibility by client and wire protocol, not only model and
   API key. A provider may support Anthropic tools but not Codex Responses tools.
2. Add a Codex canary that sends one minimal `additional_tools` item and requires
   a `custom_tool_call`, instead of treating HTTP 200 as sufficient health.
3. For oaifree, add a provider-specific adapter in AxonHub or CC Switch that
   preserves or translates `input[].additional_tools` into the exact shape the
   upstream supports. Validate with a one-tool replay before enabling broadly.
4. Do not put this workaround in `claude-code-cache-fix`: Codex reaches AxonHub
   on `:8090` through the Responses API and does not traverse the Anthropic
   cache-fix proxy on `:9801`.
5. Test historical Responses item IDs as well as tool calls. Cubence's `msg`
   prefix requirement shows that a provider can pass a fresh one-turn canary
   while failing a resumed Codex thread.

## Remaining Limitation

The investigation used existing production traces and did not replay a new
paid request to both channels. The captured requests are not identical in their
entire conversation history, but the tool item and AxonHub transformation are
byte-identical. That is sufficient to locate the missing-tool behavior at the
oaifree upstream interpretation layer, while a minimal forced-channel replay
would be the final conformance test before implementing an adapter.
