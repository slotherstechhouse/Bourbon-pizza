if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

import { PrismaClient } from "@prisma/client";
export { Prisma } from "@prisma/client";
export type {
  Fulfillment,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PromotionKind,
  StaffRole,
} from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const db = globalForPrisma.prisma ?? new PrismaClient();
export const prisma = db;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
