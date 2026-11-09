import test from 'node:test';
import assert from 'node:assert/strict';
import { readEventStream } from '../assets/shared/worker-client.js';
import { renderMarkdown } from '../assets/shared/ui.js';

function chunkedResponse(text, size = 1) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({
        start(controller) {
            for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
            controller.close();
        }
    }));
}

test('streamed UTF-8 replies survive arbitrary chunk boundaries and an unterminated last event', async () => {
    const updates = [];
    const notices = [];
    const response = chunkedResponse('data: {"notice":"Waiting"}\r\n\r\ndata: {"delta":"Café ☕"}\r\n\r\ndata: {"delta":" nearby"}');
    const result = await readEventStream(response, {onText: text => updates.push(text), onNotice: text => notices.push(text)});
    assert.equal(result, 'Café ☕ nearby');
    assert.deepEqual(updates, ['Café ☕', 'Café ☕ nearby']);
    assert.deepEqual(notices, ['Waiting']);
});

test('buffered replies use the same protocol and ignore unrelated or malformed events', async () => {
    const response = {text: async () => ': heartbeat\ndata: broken\ndata: {}\ndata: {"delta":"Hello"}\n\ndata: [DONE]\n\n'};
    assert.equal(await readEventStream(response, {onText() {}}), 'Hello');
});

test('mid-stream Worker errors keep the caller’s error type', async () => {
    class AssistantError extends Error {}
    await assert.rejects(
        readEventStream(chunkedResponse('data: {"delta":"Partial"}\n\ndata: {"error":"Try again"}\n\n', 17), {
            onText() {}, createError: message => new AssistantError(message)
        }),
        error => error instanceof AssistantError && error.message === 'Try again'
    );
});

test('Markdown preserves lists and emphasis while escaping executable HTML', () => {
    assert.equal(renderMarkdown('**Hello**\n- *Cafe*\n- <script>alert(1)</script> & tea'),
        '<strong>Hello</strong><br><ul><li><em>Cafe</em></li><li>&lt;script&gt;alert(1)&lt;/script&gt; &amp; tea</li></ul>');
});
