// Model choices shared by both pages and the Chicago Worker. No API keys belong here.
export const MODEL_GROUPS = {
    Groq: [
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b',
    ],
    Gemini: [
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
    ],
    Gemma: [
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it',
    ],
};

export const ALLOWED_MODELS = Object.values(MODEL_GROUPS).flat();
