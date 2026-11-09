// Keep endpoint selection and the Worker event protocol consistent across both apps.
export function workerEndpoint(production, development) {
    return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? development : production;
}

export async function readEventStream(response, {
    onText, onNotice, createError = message => new Error(message)
}) {
    let text = '';
    function consume(chunk) {
        for (const raw of chunk.split('\n')) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            if (data.error) throw createError(data.error);
            if (typeof data.notice === 'string') onNotice?.(data.notice);
            if (typeof data.delta === 'string') {
                text += data.delta;
                onText(text);
            }
        }
    }

    if (!response.body?.getReader) {
        consume(await response.text());
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            consume(blocks.join('\n\n'));
            if (done) {
                consume(buffer);
                return text;
            }
        }
    } finally {
        reader.releaseLock();
    }
}
