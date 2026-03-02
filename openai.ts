import OpenAI from "openai";
import { type Entry, type Goal } from "@shared/schema";

// NOTE: The blueprint provided setup code but I am importing the client from where it was created
// Check server/replit_integrations/chat/routes.ts to see where openai client is initialized or just create new one here.
// The integration instructions said "DO NOT modify the OpenAI client setup - env vars are auto-configured".
// I'll create a new instance here using the env vars as per standard OpenAI SDK usage in Replit.

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export async function analyzeEntry(entry: Entry): Promise<{ sentiment: string, sentimentScore: number, theme: string } | null> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `Analyze the following journal entry. Return a JSON object with:
          - sentiment: 'positive', 'neutral', or 'negative'
          - sentimentScore: an integer from -100 (most negative) to 100 (most positive)
          - theme: a short string (1-3 words) describing the main topic or feeling`
        },
        {
          role: "user",
          content: entry.content
        }
      ],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content;
    if (!content) return null;
    
    return JSON.parse(content);
  } catch (error) {
    console.error("Error analyzing entry:", error);
    return null;
  }
}

export async function generateWeeklyInsight(entries: Entry[], goals: Goal[]): Promise<{ summary: string, suggestions: string[] } | null> {
  try {
    const entriesText = entries.map(e => `[${e.createdAt.toISOString().split('T')[0]}] ${e.content}`).join("\n");
    const goalsText = goals.map(g => `- ${g.description} (${g.type}, ${g.isCompleted ? 'completed' : 'pending'})`).join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `You are a mental health assistant. Analyze the user's recent journal entries and goals.
          Provide a weekly summary of their mental state and progress.
          Also provide 3 actionable suggestions to help them move towards their desired state.
          Return JSON: { "summary": "string", "suggestions": ["string", "string", "string"] }`
        },
        {
          role: "user",
          content: `Entries:\n${entriesText}\n\nGoals:\n${goalsText}`
        }
      ],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content;
    if (!content) return null;

    return JSON.parse(content);
  } catch (error) {
    console.error("Error generating insight:", error);
    return null;
  }
}
