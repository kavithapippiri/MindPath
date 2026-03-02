// server/alignment.ts

type AlignmentParams = {
  content: string;
  desiredState?: string;
  actionableGoals: string[];
};

const SYNONYMS: Record<string, string[]> = {
  present: [
    "present",
    "now",
    "aware",
    "awareness",
    "mindful",
    "here",
    "grounded",
  ],
  calm: ["calm", "peaceful", "relaxed", "steady", "settled"],
  breath: ["breath", "breathing", "inhale", "exhale"],
  focus: ["focus", "focused", "attention", "concentration", "centered"],

  // Exercise / physical activity synonyms
  exercise: [
    "exercise",
    "gym",
    "workout",
    "walk",
    "walking",
    "run",
    "running",
    "training",
    "lift",
    "lifting",
  ],
  physical: [
    "physical",
    "exercise",
    "gym",
    "workout",
    "walk",
    "walking",
    "run",
    "running",
    "training",
  ],

  // Time
  minutes: ["min", "mins", "minute", "minutes"],
};

function normalize(text: string) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function expandKeywords(words: string[]) {
  const expanded = new Set<string>();

  for (const w of words) {
    expanded.add(w);

    for (const key of Object.keys(SYNONYMS)) {
      if (SYNONYMS[key].includes(w)) {
        expanded.add(key); // map variant -> canonical
      }
    }
  }

  return Array.from(expanded);
}

function unique(arr: string[]) {
  return Array.from(new Set(arr));
}

function pickPrimaryGoalText(
  desiredState?: string,
  actionableGoals: string[] = [],
) {
  // Prefer mental state if present, else first actionable goal
  const ds = (desiredState || "").trim();
  if (ds) return ds;
  return (actionableGoals[0] || "").trim();
}

/**
 * Keyword-based alignment (fast + deterministic).
 * Returns matched/missing to power "What this shows".
 */
export function computeAlignment(params: AlignmentParams) {
  const contentWords = expandKeywords(normalize(params.content));

  const goalText = (
    (params.desiredState || "") +
    " " +
    params.actionableGoals.join(" ")
  ).trim();
  const goalWords = expandKeywords(normalize(goalText));

  let hits = 0;
  const matched: string[] = [];

  for (const g of goalWords) {
    if (contentWords.includes(g)) {
      hits++;
      matched.push(g);
    }
  }

  // Boost if time commitment is present (numbers + minutes-ish goal)
  const hasNumber = contentWords.some((w) => /^\d+$/.test(w));
  const goalMentionsMinutes =
    goalWords.includes("minutes") || goalWords.includes("minute");
  if (hasNumber && goalMentionsMinutes) {
    hits += 2;
    matched.push("time commitment");
  }

  // Score
  const alignmentScore = Math.min(100, hits * 15);

  let alignmentLabel: "Aligned" | "Neutral" | "Drifting" = "Neutral";
  if (alignmentScore >= 60) alignmentLabel = "Aligned";
  else if (alignmentScore <= 30) alignmentLabel = "Drifting";

  const matchedUniq = unique(matched);
  const missing = unique(goalWords.filter((g) => !matchedUniq.includes(g)));

  return {
    alignmentScore,
    alignmentLabel,
    matched: matchedUniq,
    missing,
  };
}

/**
 * Phase 3: prompt adapts gently.
 * Accepts either a string or an object (backward compatible).
 */
export function buildDailyPrompt(
  arg?: string | { desiredState?: string; alignmentLabel?: string },
) {
  const desiredState = typeof arg === "string" ? arg : arg?.desiredState || "";
  const label = typeof arg === "string" ? undefined : arg?.alignmentLabel || "";

  const ds = (desiredState || "").trim();

  if (!ds) return "What pulled your attention away from the present today?";

  if (label === "Aligned")
    return `What helped you stay connected to "${ds}" today?`;
  if (label === "Drifting")
    return `Where did your attention wander away from "${ds}" today?`;

  return `What’s one small step today that supports being "${ds}"?`;
}

/**
 * ------------------------------
 * 🧠 Goal Quality Guardrails
 * ------------------------------
 * Uses OpenAI if available; otherwise heuristic fallback.
 */

function heuristicGoalQuality(goal: string) {
  const g = (goal || "").trim();
  const words = normalize(g);

  // Too short / nonsense
  if (words.length < 2) return false;
  if (g.length < 8) return false;

  // Looks like random letters (e.g., "blashhhhhh")
  const hasVowels = /[aeiou]/i.test(g);
  const alphaRatio = g.replace(/[^a-z]/gi, "").length / Math.max(1, g.length);
  if (!hasVowels || alphaRatio < 0.5) return false;

  // Must contain at least one meaningful keyword
  const meaningful = [
    "present",
    "calm",
    "breath",
    "mindful",
    "focus",
    "exercise",
    "workout",
    "walk",
    "sleep",
    "kids",
    "family",
    "eat",
    "healthy",
    "water",
    "journal",
    "gratitude",
    "meditate",
  ];
  const hasMeaning = words.some((w) => meaningful.includes(w) || w.length >= 6);
  if (!hasMeaning) return false;

  return true;
}

// Lazy import OpenAI so missing key never crashes server startup.
async function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: key });
}

/**
 * Returns:
 *  - ok: boolean (goal usable for alignment tracking?)
 *  - warning?: user-facing warning message if not ok
 */
export async function validateGoal(
  goal: string,
): Promise<{ ok: boolean; warning?: string }> {
  const trimmed = (goal || "").trim();
  if (!trimmed) {
    return {
      ok: false,
      warning:
        "⚠️ “Your goal is too vague for alignment tracking. Try something like: ‘stay present and calm’ or ‘focus on breath daily’.”",
    };
  }

  // Heuristic quick reject
  if (!heuristicGoalQuality(trimmed)) {
    return {
      ok: false,
      warning:
        "⚠️ “Your goal is too vague for alignment tracking. Try something like: ‘stay present and calm’ or ‘focus on breath daily’.”",
    };
  }

  // Optional: OpenAI deeper check (if key exists)
  const openai = await getOpenAI();
  if (!openai) return { ok: true };

  try {
    const prompt = `Is this a meaningful personal growth goal that can be tracked in journaling? 
Goal: "${trimmed}"
Respond ONLY with YES or NO.`;

    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const out = (res.choices?.[0]?.message?.content || "").toUpperCase();
    const ok = out.includes("YES");

    return ok
      ? { ok: true }
      : {
          ok: false,
          warning:
            "⚠️ “Your goal is too vague for alignment tracking. Try something like: ‘stay present and calm’ or ‘focus on breath daily’.”",
        };
  } catch {
    // If OpenAI fails, still allow (don’t block)
    return { ok: true };
  }
}

/**
 * Intent detection: A/B/C
 * A) fulfill goal
 * B) fail goal
 * C) unrelated
 *
 * Uses OpenAI if available; otherwise heuristic.
 */
export async function detectIntent(
  entry: string,
  goal: string,
): Promise<"A" | "B" | "C"> {
  const openai = await getOpenAI();

  // Heuristic fallback
  if (!openai) {
    const e = normalize(entry);
    const g = normalize(goal);

    // If no overlap at all, unrelated
    const overlap = g.filter((w) => e.includes(w));
    if (overlap.length === 0) return "C";

    // Simple negation detection
    const negWords = [
      "not",
      "didnt",
      "didn't",
      "forgot",
      "missed",
      "failed",
      "couldnt",
      "couldn't",
    ];
    const hasNeg = e.some((w) => negWords.includes(w));

    return hasNeg ? "B" : "A";
  }

  try {
    const prompt = `Goal: "${goal}"
Journal entry: "${entry}"

Did the user:
A) Fulfill the goal
B) Fail the goal
C) Unrelated to the goal

Respond ONLY with A, B, or C.`;

    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const out = (res.choices?.[0]?.message?.content || "").trim().toUpperCase();
    if (out.startsWith("A")) return "A";
    if (out.startsWith("B")) return "B";
    return "C";
  } catch {
    return "C";
  }
}
