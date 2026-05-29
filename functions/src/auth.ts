import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase";
import { jwtSecret } from "./config";
import { UserProfile } from "./models";

export type AuthContext = {
  uid: string;
  email: string;
  role?: string | null;
};

export function generateUid(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 28; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const hashAsync = promisify(bcrypt.hash);
const compareAsync = promisify(bcrypt.compare);

export async function hashPassword(password: string): Promise<string> {
  return hashAsync(password, 12) as Promise<string>;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return compareAsync(password, hash) as Promise<boolean>;
}

export function signToken(payload: AuthContext): string {
  const secret = jwtSecret.value();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthContext {
  const secret = jwtSecret.value();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return jwt.verify(token, secret) as AuthContext;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
    return;
  }
  try {
    const token = authHeader.split("Bearer ")[1];
    const decoded = verifyToken(token);
    (req as any).authContext = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: { message: "Invalid token", status: "UNAUTHENTICATED" } });
  }
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.split("Bearer ")[1];
      const decoded = verifyToken(token);
      (req as any).authContext = decoded;
    } catch {
      // ignore invalid optional token
    }
  }
  next();
}

export async function handleRegister(req: Request, res: Response) {
  try {
    const { name, email, password, phone, role } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: { message: "name is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!email || typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
      res.status(400).json({ error: { message: "A valid email is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      res.status(400).json({ error: { message: "password is required and must be at least 6 characters.", status: "INVALID_ARGUMENT" } });
      return;
    }

    const validRoles = ["client", "customer", "student", "seller"];
    const roleInput = typeof role === "string" ? role.trim() : null;
    if (!roleInput || !validRoles.includes(roleInput)) {
      res.status(400).json({ error: { message: `role is required and must be one of: ${validRoles.join(", ")}.`, status: "INVALID_ARGUMENT" } });
      return;
    }

    const existing = await db.collection("users").where("email", "==", email.toLowerCase().trim()).limit(1).get();
    if (!existing.empty) {
      res.status(409).json({ error: { message: "An account with this email already exists.", status: "ALREADY_EXISTS" } });
      return;
    }

    const uid = generateUid();
    const passwordHash = await hashPassword(password);
    const now = FieldValue.serverTimestamp();

    await db.collection("users").doc(uid).set({
      uid,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone ? String(phone).trim() : null,
      role: roleInput,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    const token = signToken({ uid, email: email.toLowerCase().trim(), role: roleInput });

    res.status(201).json({
      ok: true,
      uid,
      token,
      user: {
        uid,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        phone: phone ? String(phone).trim() : null,
        role: roleInput,
      },
    });
  } catch (error: any) {
    console.error("Register error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== "string") {
      res.status(400).json({ error: { message: "email is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!password || typeof password !== "string") {
      res.status(400).json({ error: { message: "password is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    const snapshot = await db.collection("users").where("email", "==", email.toLowerCase().trim()).limit(1).get();
    if (snapshot.empty) {
      res.status(401).json({ error: { message: "Invalid email or password.", status: "UNAUTHENTICATED" } });
      return;
    }

    const userDoc = snapshot.docs[0];
    const user = userDoc.data() as UserProfile;

    if (!user.passwordHash) {
      res.status(401).json({ error: { message: "Invalid email or password.", status: "UNAUTHENTICATED" } });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: { message: "Invalid email or password.", status: "UNAUTHENTICATED" } });
      return;
    }

    const token = signToken({ uid: user.uid, email: user.email, role: user.role });

    res.json({
      ok: true,
      token,
      user: {
        uid: user.uid,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleGetMe(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const doc = await db.collection("users").doc(authContext.uid).get();
    if (!doc.exists) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = doc.data() as UserProfile;
    res.json({
      uid: user.uid,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
    });
  } catch (error: any) {
    console.error("GetMe error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}
