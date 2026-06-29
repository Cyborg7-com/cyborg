import { describe, it, expect, afterAll } from "vitest";
import { getDb, closePool } from "./connection.js";
import { users } from "./schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

describe("PostgreSQL connection via Drizzle", () => {
  afterAll(async () => {
    await closePool();
  });

  it("connects and runs a query", async () => {
    const db = getDb();
    const id = randomUUID();
    const email = `test-${id}@e2e.dev`;

    await db.insert(users).values({ id, email, name: "Drizzle Test" });

    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.email).toBe(email);
    expect(row.name).toBe("Drizzle Test");

    await db.delete(users).where(eq(users.id, id));
  });
});
