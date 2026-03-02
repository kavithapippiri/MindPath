import { storage } from "./storage";

export async function seedDatabase() {
  // We can't easily seed user-specific data without a user ID.
  // But we can ensure the system is ready.
  console.log("Database seeded successfully (no global seed data needed for this app).");
}
