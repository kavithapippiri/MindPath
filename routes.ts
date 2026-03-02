import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { registerChatRoutes } from "./replit_integrations/chat";
import { registerImageRoutes } from "./replit_integrations/image";
import { registerAudioRoutes } from "./replit_integrations/audio";
import { api } from "@shared/routes";
import { analyzeEntry, generateWeeklyInsight } from "./openai";
import { computeAlignment, validateGoal, detectIntent } from "./alignment";

/* -------------------------
   Auth middleware
------------------------- */
const requireAuth = (req: any, res: any, next: any) => {
  if (req.isAuthenticated?.()) return next();
  return res.status(401).json({ message: "Unauthorized" });
};

/* -------------------------
   Onboarding helper
------------------------- */
async function checkMentalStateGoal(userId: string) {
  const goals = await storage.getGoals(userId);
  const mentalStateGoal = goals.find((g) => g.type === "mental_state");
  return { goals, hasMentalStateGoal: !!mentalStateGoal };
}

/* -------------------------
   Unified emotional scoring (ONE logic)
   Uses entries.sentimentScore only
------------------------- */
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Your DB shows sentimentScore values like -65..82. We'll treat it as [-100..100].
function scoreToPercent(score: number) {
  return clamp(Math.round(((score + 100) / 200) * 100), 0, 100);
}

function percentToLabel(p: number) {
  if (p >= 70) return "Mostly Positive";
  if (p >= 55) return "Positive";
  if (p >= 45) return "Balanced";
  if (p >= 30) return "Low";
  return "Mostly Negative";
}

function computeEmotionalTone(entries: any[]) {
  const scores = entries
    .map((e) =>
      typeof e.sentimentScore === "number" ? e.sentimentScore : null,
    )
    .filter((v) => v !== null) as number[];

  if (!scores.length) {
    // neutral default when there is no sentiment data
    return { percent: 50, label: "Balanced" };
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const percent = scoreToPercent(avg);
  return { percent, label: percentToLabel(percent) };
}

function computeSentimentTrend(entries: any[]) {
  // Group by date (YYYY-MM-DD) and average sentimentScore
  const byDay = new Map<string, number[]>();

  for (const e of entries) {
    if (typeof e.sentimentScore !== "number") continue;
    const d = new Date(e.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`;

    const arr = byDay.get(key) ?? [];
    arr.push(e.sentimentScore);
    byDay.set(key, arr);
  }

  const days = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, scores]) => {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return { date, percent: scoreToPercent(avg) };
    });

  return days;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);
  registerChatRoutes(app);
  registerImageRoutes(app);
  registerAudioRoutes(app);

  /* -------------------------
     Onboarding status
  ------------------------- */
  app.get("/api/onboarding/status", requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const { hasMentalStateGoal } = await checkMentalStateGoal(userId);
    res.json({ hasMentalStateGoal });
  });

  /* -------------------------
     Dashboard (FIX for “0 / 50%”)
     Unifies Emotional tone + Sentiment trends
  ------------------------- */
  app.get("/api/dashboard/stats", requireAuth, async (req: any, res) => {
    const userId = (req.user as any).claims.sub;

    const [entries, goals] = await Promise.all([
      storage.getEntries(userId),
      storage.getGoals(userId),
    ]);

    const totalEntries = entries.length;

    const activeGoals = goals.filter((g) => !g.isCompleted).length;
    const completedGoals = goals.filter((g) => g.isCompleted).length;

    const emotionalTone = computeEmotionalTone(entries);

    res.json({
      totalEntries,
      activeGoals,
      completedGoals,
      emotionalTonePercent: emotionalTone.percent,
      emotionalToneLabel: emotionalTone.label,
    });
  });

  app.get(
    "/api/dashboard/sentiment-trends",
    requireAuth,
    async (req: any, res) => {
      const userId = (req.user as any).claims.sub;
      const entries = await storage.getEntries(userId);

      // last ~30 points max (optional)
      const trend = computeSentimentTrend(entries).slice(-30);

      res.json(trend);
    },
  );

  /* -------------------------
     Entries
  ------------------------- */
  app.get(api.entries.list.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const entries = await storage.getEntries(userId);
    res.json(entries);
  });

  // Explain endpoint (mirrors create route logic)
  app.get(
    "/api/phase2/alignment/explain/:id",
    requireAuth,
    async (req, res) => {
      const userId = (req.user as any).claims.sub;
      const entryId = Number(req.params.id);

      const [entry, goalsList] = await Promise.all([
        storage.getEntry(entryId),
        storage.getGoals(userId),
      ]);

      if (!entry) return res.status(404).json({ message: "Entry not found" });

      const desiredState =
        goalsList.find((g: any) => g.type === "mental_state" && !g.isCompleted)
          ?.description ||
        goalsList.find((g: any) => g.type === "mental_state")?.description ||
        "";

      const actionableGoals = goalsList
        .filter((g: any) => g.type === "actionable" && !g.isCompleted)
        .map((g: any) => g.description);

      const validation = await validateGoal(desiredState);

      let result = computeAlignment({
        content: entry.content,
        desiredState: validation.ok ? desiredState : "",
        actionableGoals: validation.ok ? actionableGoals : [],
      });

      if (validation.ok) {
        const primaryGoal = desiredState || actionableGoals[0] || "";
        if (primaryGoal.trim()) {
          const intent = await detectIntent(entry.content, primaryGoal);

          if (intent === "A") {
            result = {
              ...result,
              alignmentScore: Math.max(result.alignmentScore, 70),
              alignmentLabel: "Aligned",
            };
          } else if (intent === "B") {
            result = {
              ...result,
              alignmentScore: Math.min(result.alignmentScore, 30),
              alignmentLabel: "Drifting",
            };
          }
        }
      }

      res.json(result);
    },
  );

  app.post(api.entries.create.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const input = api.entries.create.input.parse(req.body);

    const { goals, hasMentalStateGoal } = await checkMentalStateGoal(userId);
    if (!hasMentalStateGoal) {
      return res.status(409).json({
        code: "MENTAL_STATE_GOAL_REQUIRED",
        redirectTo: "/onboarding",
        message:
          "Before journaling, set one guiding intention (a mental-state goal).",
      });
    }

    const desiredState =
      goals.find((g) => g.type === "mental_state" && !g.isCompleted)
        ?.description ||
      goals.find((g) => g.type === "mental_state")?.description ||
      "";

    const actionableGoals = goals
      .filter((g) => g.type === "actionable" && !g.isCompleted)
      .map((g) => g.description);

    const alignment = computeAlignment({
      content: input.content,
      desiredState,
      actionableGoals,
    });

    const entry = await storage.createEntry(userId, input);

    await storage.updateEntryAnalysis(entry.id, alignment);

    analyzeEntry(entry).then((analysis) => {
      if (analysis) {
        storage.updateEntryAnalysis(entry.id, {
          ...analysis,
          alignmentScore: alignment.alignmentScore,
          alignmentLabel: alignment.alignmentLabel,
        });
      }
    });

    res.status(201).json({
      ...entry,
      alignmentScore: alignment.alignmentScore,
      alignmentLabel: alignment.alignmentLabel,
    });
  });

  // Edit entry
  app.patch("/api/entries/:id", requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const id = Number(req.params.id);
    const { content } = req.body;

    if (!content || content.trim().length < 5) {
      return res.status(400).json({ message: "Invalid content" });
    }

    const goals = await storage.getGoals(userId);
    const desiredState =
      goals.find((g) => g.type === "mental_state" && !g.isCompleted)
        ?.description ||
      goals.find((g) => g.type === "mental_state")?.description ||
      "";

    const actionableGoals = goals
      .filter((g) => g.type === "actionable" && !g.isCompleted)
      .map((g) => g.description);

    const alignment = computeAlignment({
      content,
      desiredState,
      actionableGoals,
    });

    const updated = await storage.updateEntry(userId, id, content, alignment);
    if (!updated) return res.status(404).json({ message: "Entry not found" });

    res.json(updated);
  });

  app.delete("/api/entries/:id", requireAuth, async (req, res) => {
    await storage.deleteEntry(Number(req.params.id));
    res.sendStatus(200);
  });

  /* -------------------------
     Goals
  ------------------------- */
  app.get(api.goals.list.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    res.json(await storage.getGoals(userId));
  });

  app.post(api.goals.create.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const input = api.goals.create.input.parse(req.body);
    res.status(201).json(await storage.createGoal(userId, input));
  });

  // Edit goal
  app.patch("/api/goals/:id", requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const id = Number(req.params.id);
    const { description } = req.body;

    const updated = await storage.updateGoal(userId, id, description);
    if (!updated) return res.status(404).json({ message: "Goal not found" });

    res.json(updated);
  });

  app.patch(api.goals.toggle.path, requireAuth, async (req, res) => {
    const goal = await storage.toggleGoal(Number(req.params.id));
    if (!goal) return res.status(404).json({ message: "Goal not found" });
    res.json(goal);
  });

  app.delete(api.goals.delete.path, requireAuth, async (req, res) => {
    await storage.deleteGoal(Number(req.params.id));
    res.sendStatus(204);
  });

  /* -------------------------
     Insights
  ------------------------- */
  app.get(api.insights.latest.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    res.json(await storage.getLatestInsight(userId));
  });

  app.post(api.insights.generate.path, requireAuth, async (req, res) => {
    const userId = (req.user as any).claims.sub;
    const entries = await storage.getEntries(userId);
    const goals = await storage.getGoals(userId);

    const generated = await generateWeeklyInsight(entries.slice(0, 10), goals);
    if (!generated) return res.status(500).json({ message: "Failed" });

    res.status(201).json(
      await storage.createInsight(userId, {
        summary: generated.summary,
        suggestions: generated.suggestions,
        weekStartDate: new Date(),
      }),
    );
  });

  return httpServer;
}
