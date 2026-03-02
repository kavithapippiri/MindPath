import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import {
  entries,
  goals,
  insights,
  users,
  type Entry,
  type InsertEntry,
  type Goal,
  type InsertGoal,
  type Insight,
  type User,
  type UpsertUser,
} from "@shared/schema";

/* =========================
   Storage Interface
========================= */
export interface IStorage {
  // Auth
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  // Entries
  getEntries(userId: string): Promise<Entry[]>;
  getEntry(id: number): Promise<Entry | undefined>;
  createEntry(userId: string, entry: InsertEntry): Promise<Entry>;
  deleteEntry(id: number): Promise<void>;

  updateEntry(
    userId: string,
    id: number,
    content: string,
    alignment: {
      alignmentScore: number;
      alignmentLabel: "Aligned" | "Neutral" | "Drifting";
    },
  ): Promise<Entry | null>;

  updateEntryAnalysis(
    id: number,
    analysis: {
      sentiment?: string;
      sentimentScore?: number;
      theme?: string;
      alignmentScore?: number;
      alignmentLabel?: "Aligned" | "Neutral" | "Drifting" | string;
    },
  ): Promise<Entry>;

  // Goals
  getGoals(userId: string): Promise<Goal[]>;
  getGoal(id: number): Promise<Goal | undefined>;
  createGoal(userId: string, goal: InsertGoal): Promise<Goal>;
  toggleGoal(id: number): Promise<Goal | undefined>;
  updateGoal(
    userId: string,
    id: number,
    description: string,
  ): Promise<Goal | null>;
  deleteGoal(id: number): Promise<void>;

  // Insights
  getLatestInsight(userId: string): Promise<Insight | undefined>;
  createInsight(
    userId: string,
    insight: {
      summary: string;
      suggestions: string[];
      weekStartDate: Date;
    },
  ): Promise<Insight>;
}

/* =========================
   Database Storage
========================= */
export class DatabaseStorage implements IStorage {
  /* ---------- Auth ---------- */
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: { ...userData, updatedAt: new Date() },
      })
      .returning();
    return user;
  }

  /* ---------- Entries ---------- */
  async getEntries(userId: string): Promise<Entry[]> {
    return db
      .select()
      .from(entries)
      .where(eq(entries.userId, userId))
      .orderBy(desc(entries.createdAt));
  }

  async getEntry(id: number): Promise<Entry | undefined> {
    const [entry] = await db.select().from(entries).where(eq(entries.id, id));
    return entry;
  }

  async createEntry(userId: string, entry: InsertEntry): Promise<Entry> {
    const [created] = await db
      .insert(entries)
      .values({ ...entry, userId })
      .returning();
    return created;
  }

  async deleteEntry(id: number): Promise<void> {
    await db.delete(entries).where(eq(entries.id, id));
  }

  /* ✅ Edit entry (USED BY PATCH /api/entries/:id) */
  async updateEntry(
    userId: string,
    id: number,
    content: string,
    alignment: {
      alignmentScore: number;
      alignmentLabel: "Aligned" | "Neutral" | "Drifting";
    },
  ): Promise<Entry | null> {
    const [existing] = await db
      .select()
      .from(entries)
      .where(eq(entries.id, id));

    if (!existing || existing.userId !== userId) return null;

    const [updated] = await db
      .update(entries)
      .set({
        content,
        alignmentScore: alignment.alignmentScore,
        alignmentLabel: alignment.alignmentLabel,
        updatedAt: new Date(),
      })
      .where(eq(entries.id, id))
      .returning();

    return updated;
  }

  /* Partial AI analysis updates */
  async updateEntryAnalysis(
    id: number,
    analysis: {
      sentiment?: string;
      sentimentScore?: number;
      theme?: string;
      alignmentScore?: number;
      alignmentLabel?: "Aligned" | "Neutral" | "Drifting" | string;
    },
  ): Promise<Entry> {
    const [updated] = await db
      .update(entries)
      .set(analysis)
      .where(eq(entries.id, id))
      .returning();
    return updated;
  }

  /* ---------- Goals ---------- */
  async getGoals(userId: string): Promise<Goal[]> {
    return db
      .select()
      .from(goals)
      .where(eq(goals.userId, userId))
      .orderBy(desc(goals.createdAt));
  }

  async getGoal(id: number): Promise<Goal | undefined> {
    const [goal] = await db.select().from(goals).where(eq(goals.id, id));
    return goal;
  }

  async createGoal(userId: string, goal: InsertGoal): Promise<Goal> {
    const [created] = await db
      .insert(goals)
      .values({ ...goal, userId })
      .returning();
    return created;
  }

  async toggleGoal(id: number): Promise<Goal | undefined> {
    const goal = await this.getGoal(id);
    if (!goal) return undefined;

    const [updated] = await db
      .update(goals)
      .set({ isCompleted: !goal.isCompleted })
      .where(eq(goals.id, id))
      .returning();

    return updated;
  }

  /* ✅ Edit goal (USED BY PATCH /api/goals/:id) */
  async updateGoal(
    userId: string,
    id: number,
    description: string,
  ): Promise<Goal | null> {
    const [existing] = await db.select().from(goals).where(eq(goals.id, id));

    if (!existing || existing.userId !== userId) return null;

    const [updated] = await db
      .update(goals)
      .set({
        description,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, id))
      .returning();

    return updated;
  }

  async deleteGoal(id: number): Promise<void> {
    await db.delete(goals).where(eq(goals.id, id));
  }

  /* ---------- Insights ---------- */
  async getLatestInsight(userId: string): Promise<Insight | undefined> {
    const [insight] = await db
      .select()
      .from(insights)
      .where(eq(insights.userId, userId))
      .orderBy(desc(insights.weekStartDate))
      .limit(1);
    return insight;
  }

  async createInsight(
    userId: string,
    data: {
      summary: string;
      suggestions: string[];
      weekStartDate: Date;
    },
  ): Promise<Insight> {
    const [created] = await db
      .insert(insights)
      .values({ ...data, userId })
      .returning();
    return created;
  }
}

/* =========================
   Exports
========================= */
export const storage = new DatabaseStorage();
export const authStorage = storage;
