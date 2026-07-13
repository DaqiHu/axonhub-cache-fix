# Anthropic `cache_control` Provider Compatibility

Research date: 2026-07-13

This note separates provider-documented behavior from assumptions about AxonHub or other third-party adapters. Absence from documentation is classified as **undocumented**, not as evidence that a field is ignored or rejected.

## OpenAI (`gpt-5.6` family)

### Conclusion

OpenAI's native APIs do not use Anthropic's `cache_control` field. For GPT-5.6 and later model families, OpenAI documents automatic exact-prefix caching plus its own cache controls:

- request routing through `prompt_cache_key`;
- request-wide policy through `prompt_cache_options`;
- explicit content-block markers through `prompt_cache_breakpoint`;
- cache read and write metrics through `cached_tokens` and `cache_write_tokens`.

The official Responses and Chat Completions create-reference pages contain no `cache_control` field. This establishes the native OpenAI request schema, but it does not establish how a third-party Anthropic-to-OpenAI adapter handles an incoming Anthropic `cache_control` field before it calls OpenAI.

### Evidence

The official [OpenAI Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) says caching is automatic and requires exact prompt-prefix matches. For GPT-5.6 and later families, it documents `prompt_cache_key`, `prompt_cache_options`, and `prompt_cache_breakpoint` as the supported controls. It also states that cache markers on unsupported blocks return `400 invalid_request_error`.

The official [Responses create reference](https://developers.openai.com/api/docs/api-reference/responses/create) and [Chat Completions create reference](https://developers.openai.com/api/docs/api-reference/chat/create) document OpenAI's cache-specific fields but do not define Anthropic `cache_control`. A full-page term check on 2026-07-13 found zero `cache_control` occurrences in either create reference.

Therefore, OpenAI's official documentation classifies an Anthropic-format request to a third-party adapter as outside the native OpenAI API contract. It is not valid to infer from the OpenAI docs alone that the adapter ignores, strips, translates, or rejects `cache_control`.

## Z.AI / BigModel (`glm-5.2`)

### Conclusion

Z.AI officially documents automatic context caching for GLM-5.2, but it does **not** document how its Anthropic-compatible `/v1/messages` endpoint handles Anthropic content-block `cache_control` fields. The available official documentation does not establish whether that field is supported, ignored, stripped before native inference, passed through into cache-key material, or rejected.

Therefore, GLM-5.2 should currently be classified as:

| Question | Officially documented result |
|---|---|
| Does GLM-5.2 support context caching? | Yes |
| Is caching automatic or manually marked? | Automatic and implicit; no manual configuration is required |
| Is Anthropic `cache_control` supported? | Undocumented |
| Is Anthropic `cache_control` ignored or stripped? | Undocumented |
| Is Anthropic `cache_control` rejected? | Undocumented |
| Does the Anthropic-compatible response expose cache metrics? | Undocumented |
| What cache metric is documented for the native API? | `usage.prompt_tokens_details.cached_tokens` |

### Evidence

The official [Claude API compatibility guide](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction) provides an Anthropic-compatible base URL, `https://open.bigmodel.cn/api/anthropic`, and shows GLM-5.2 being called through Anthropic SDKs and `/v1/messages`. It says migration normally requires changing the base URL, API key, and model name. However, the same page warns that differences from the Claude interface still exist. It does not publish a supported-parameter matrix, mention `cache_control`, or show cache-related request or response fields.

The official [BigModel context-caching guide](https://docs.bigmodel.cn/cn/guide/capabilities/cache) explicitly describes caching as "implicit" and automatic, with no manual configuration required. It lists GLM-5.2 among supported models and documents the response metric `usage.prompt_tokens_details.cached_tokens`. Its examples use the native/OpenAI-compatible `https://open.bigmodel.cn/api/paas/v4/chat/completions` endpoint and ordinary `messages`; none uses an Anthropic `cache_control` marker.

The official [GLM-5.2 model page](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2) lists context caching as a model capability, but does not define request fields or Anthropic-compatibility behavior for caching.

The English [Z.AI context-caching guide](https://docs.z.ai/guides/capabilities/cache) describes the same native mechanism: automatic cache recognition without manual configuration and the `usage.prompt_tokens_details.cached_tokens` metric. It likewise does not document Anthropic `cache_control`.

As a completeness check, the official full documentation indexes at [BigModel `llms-full.txt`](https://docs.bigmodel.cn/llms-full.txt) and [Z.AI `llms-full.txt`](https://docs.z.ai/llms-full.txt) contained no `cache_control` or `cache-control` occurrence when checked on 2026-07-14. This supports the **undocumented** classification only; it does not prove runtime behavior.

### Anthropic compatibility is not native cache control

Two separate facts must not be conflated:

1. The Anthropic SDK can send messages to Z.AI's compatibility endpoint.
2. GLM-5.2's native platform automatically caches repeated context.

Neither fact establishes how the compatibility layer parses Anthropic's per-content-block `cache_control` metadata. The documented native cache metric also cannot be assumed to appear unchanged in an Anthropic-format response; the compatibility guide does not specify a mapping to Anthropic fields such as `cache_read_input_tokens` or `cache_creation_input_tokens`.

### Recommendation for `deepseek-cache-optimize`

Do not remove the DeepSeek-only gate based on Z.AI documentation. The extension removes Anthropic `cache_control` metadata because DeepSeek's behavior and the AxonHub translation path were specifically investigated. Applying the same transformation to GLM-5.2 would currently rely on an undocumented assumption about Z.AI's compatibility layer.

If GLM support is pursued later, gate the behavior by a verified provider/channel capability rather than a broad model-name match. Promotion should require an end-to-end test through the actual AxonHub channel that compares otherwise identical requests with and without `cache_control`, checking:

- HTTP acceptance or rejection;
- the native request after translation, if observable;
- response cache metrics for repeated prefixes;
- whether changing only `cache_control` changes the cache hit;
- preservation of Anthropic semantics on providers that implement explicit cache breakpoints.

Until that evidence exists, retain the current DeepSeek gate and leave GLM-5.2 unchanged.

## Current AxonHub routing implications

The local AxonHub configuration does not send `gpt-5.6-sol` to an official OpenAI Anthropic-compatible endpoint. It routes that alias through third-party channels of type `codex`. `glm-5.2` is available through more than one third-party channel type, including Anthropic-style adapters. No credentials are needed to establish this routing fact.

Consequently, model vendor documentation is necessary but not sufficient for changing `deepseek-cache-optimize`:

| Model alias | Vendor documentation | Actual decision owner for incoming Anthropic `cache_control` |
|---|---|---|
| `gpt-5.6-sol` | OpenAI documents only native OpenAI cache fields | AxonHub plus the selected third-party `codex` adapter |
| `glm-5.2` | Z.AI documents automatic native caching; Anthropic field behavior is undocumented | AxonHub plus the selected GLM channel/compatibility adapter |
| DeepSeek models | DeepSeek explicitly documents Anthropic `cache_control` as ignored | The currently verified DeepSeek translation path |

The safe decision is to retain the DeepSeek-only gate. Do not generalize by model name and do not remove the extension. If another channel is proven to ignore or strip Anthropic `cache_control`, add a provider/channel capability after an end-to-end comparison through that exact route. The other stabilization extensions are already model-unrestricted and require no change for this question.
