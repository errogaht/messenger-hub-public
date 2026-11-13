# Reading files and viewing images (0.7.7)

Two IDs have different namespaces. `attachments[].id` is the provider attachment
ID within an exact source message. `attachments[].fileId` is a Hub UUID from the
scoped durable media registry. Neither names nor UUID appearance prove ownership.

Preferred single-ID tool:

```json
{"fileId":"11111111-1111-4111-8111-111111111111"}
```

Call `messenger_file_download` using a real `attachments[].fileId` from authorized
history/message_get. Hub resolves connection, conversation, source message and
provider ID, checks grants, uses cached bytes or downloads that source. JPEG,
PNG, WebP, GIF <=8 MiB add a native MCP `content` image block; metadata remains in
structuredContent, with `imagePreview.status=inline`. No base64 is serialized as
text/JSON. Other files preserve download behavior; large/unsupported images return
`imagePreview.status=omitted` and a next action for the available private local path.
No resizing, model invocation, public publishing or sends. HTTP file_download keeps
its metadata/path contract; raw attachment API still returns base64.

Legacy/source-addressed alternative:

```json
{"connectionId":"telegram-main","conversationId":"100000002","messageId":"101","attachmentId":"message:101"}
```

Call `messenger_attachment` with `attachments[].id`, NOT `fileId`. For compatibility,
a known registry UUID is safely resolved if both scopes and all three source fields
match. It cannot be used to cross routes/accounts/messages. Unknown IDs retain the
provider's strict validation; there is no fuzzy matching. `attachment_mismatch`
and `attachment_route_mismatch` are input/binding errors (`retryable:false`,
`category:input_error`) with specific tool/field instructions. Do not treat these
as provider outages or ask the sender to resend. Correct the input from exact
source metadata or use file_download with the registered UUID.
