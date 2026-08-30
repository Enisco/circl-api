/**
 * The front page of the docs. It carries the two things a reader cannot discover from the route
 * list: what wraps every response, and the WebSocket contract, which no OpenAPI document can
 * describe.
 */
export const API_DESCRIPTION = `
Backend for the Circl platform.

## Every response has the same envelope

Successful responses are wrapped by one interceptor, so the payload is always under \`data\`:

\`\`\`jsonc
{ "success": true, "status": "success", "message": "…", "data": { }, "meta": { } }
\`\`\`

**This includes the auth routes.** \`accessToken\`, \`refreshToken\` and \`sessionId\` are inside
\`data\`, not at the top level. A client reading \`body.accessToken\` gets null and will treat a
returning member as a new signup.

Failures use the same shape with \`success: false\` and an \`error\` object. \`error.code\` is the
stable machine-readable value; \`error.details\` names the offending fields on a validation
failure. A shape violation is \`400\`; something well formed but semantically invalid is \`422\`.

List responses add \`meta\` with \`currentPage\`, \`perPage\`, \`totalPages\`, \`totalCount\`,
\`hasNextPage\` and \`hasPreviousPage\`.

## Media: send a key, read a URL

Uploads mint an S3 object key. Write requests take \`…Key\` / \`…Keys\`; responses always return
\`…Url\`, signed and rotated daily. There is no exception in either direction.

## Messaging runs over Socket.IO, not a raw WebSocket

The realtime half of Section 5 is **not** in this document, because OpenAPI cannot describe it.

- **URL** \`wss://{host}/ws/chat\` — a Socket.IO namespace
- **Auth** \`auth: { token }\` on the handshake, or \`?token=\`. An invalid token closes with **4401**
- **Heartbeat** ping every 30s, closed after two missed pongs

**Client → server:** \`message.send\` \`{ clientId, conversationId, kind?, body?, attachmentKeys? }\` ·
\`message.read\` \`{ conversationId, lastReadMessageId }\` · \`typing.start\` / \`typing.stop\`
\`{ conversationId }\` · \`sync\` \`{ cursors: [{ conversationId, lastMessageId }] }\`

**Server → client:** \`message.new\` · \`message.ack\` (echoes \`clientId\`, so the optimistic bubble
is replaced rather than duplicated) · \`message.status\` (\`SENT\` / \`DELIVERED\` / \`FAILED\`) ·
\`message.read\` · \`typing\` · \`presence\` · \`conversation.updated\` · \`unread.total\`

\`sync\` is the one that matters most: after a reconnect the server replays what was missed, so a
member who went through a tunnel does not lose messages silently.

\`POST /messages/{id}/messages\` is the REST fallback for a client that cannot hold a connection.
It performs the same delivery as the socket path, so a recipient who is connected still receives
\`message.new\` and the sender's tick still reaches \`DELIVERED\`.

## Not built this release

Verification (D13): \`GET /verification/status\` returns \`EMAIL\` verified and every other check
\`NOT_STARTED\`. Nothing can reach \`VERIFIED\`, and listings stay \`UNVERIFIED\` while remaining
live, browsable, bookable and messageable.
`.trim();
