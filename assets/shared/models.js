// Model choices shared by both pages and both Workers. No API keys belong here.
// The first entry is what the pickers show by default, so keep the default model first.
export const MODEL_GROUPS = {
    Claude: [
        'claude-haiku-5-5',
    ],
    Groq: [
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b',
    ],
};

export const ALLOWED_MODELS = Object.values(MODEL_GROUPS).flat();
