# In-App Prompt Editor

This app exposes a simple prompt editor (System / Guidelines / Rubric) under the "프롬프트 엔지니어링 설정" section on the left panel.
- Values are saved to localStorage under key `ai_coach_prompts`.
- The current fallback coach response uses these values to shape tone and structure.
- When integrating a backend LLM, include these fields in your API payload as context.

Suggested payload:
{
  user: "message",
  metrics: { ... },
  reference: "...",
  prompt: {
    system: "...",
    guidelines: "...",
    rubric: "..."
  }
}

