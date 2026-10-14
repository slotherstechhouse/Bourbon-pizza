import { getAuth } from "@clerk/express";
import type { RequestHandler, Response } from "express";
import { db, type StaffRole } from "@workspace/db";

export type StaffIdentity = {
  id: string;
  clerkId: string;
  role: StaffRole;
};

export function requireStaffRoles(...allowedRoles: StaffRole[]): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const userId = getAuth(req).userId;
    if (!userId) {
      res.status(401).json({ error: "Sign in with an authorized staff account." });
      return;
    }

    const staffUser = await db.staffUser.findUnique({
      where: { clerkId: userId },
      select: { id: true, clerkId: true, role: true },
    });
    if (!staffUser) {
      res.status(403).json({ error: "This account has not been granted restaurant staff access." });
      return;
    }
    if (!allowedRoles.includes(staffUser.role)) {
      res.status(403).json({ error: "Your staff role cannot access this operation." });
      return;
    }

    res.locals.staffUser = staffUser satisfies StaffIdentity;
    next();
  };
}

export function getStaffIdentity(res: Response): StaffIdentity {
  return res.locals.staffUser as StaffIdentity;
}
