import { MODEL_GROUPS } from './models.js';

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderMarkdown(text) {
    // Escape model output before applying the supported Markdown subset.
    const escaped = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return escaped
        .split('\n')
        .map(line => /^\s*[-•*]\s+/.test(line)
            ? `<li>${line.replace(/^\s*[-•*]\s+/, '')}</li>`
            : line)
        .join('\n')
        .replace(/(?:<li>.*?<\/li>\n?)+/g, run => `<ul>${run.replace(/\n/g, '')}</ul>`)
        .replace(/\n/g, '<br>');
}

export function populateModelSelect(select, labels = {}) {
    select.replaceChildren();
    for (const [name, models] of Object.entries(MODEL_GROUPS)) {
        const group = document.createElement('optgroup');
        group.label = labels[name] || name;
        for (const model of models) group.appendChild(new Option(model, model));
        select.appendChild(group);
    }
}
