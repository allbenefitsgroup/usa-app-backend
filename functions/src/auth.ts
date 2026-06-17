import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import { GetCommand, PutCommand, ScanCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, USERS_TABLE, REVOKED_TOKENS_TABLE, SERVICES_TABLE } from "./dynamodb";
import { jwtSecret, emailApiKey, supportEmail, appUrl, adminEmail } from "./config";
import { sendWelcomeEmail, sendAdminNotificationEmail } from "./email";

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

export async function isTokenRevoked(token: string): Promise<boolean> {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: REVOKED_TOKENS_TABLE,
        Key: { token },
      })
    );
    return !!result.Item;
  } catch {
    return false;
  }
}

export async function revokeToken(token: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: REVOKED_TOKENS_TABLE,
      Item: {
        token,
        revokedAt: new Date().toISOString(),
      },
    })
  );
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

    if (await isTokenRevoked(token)) {
      res.status(401).json({ error: { message: "Token has been revoked", status: "UNAUTHENTICATED" } });
      return;
    }

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

      if (await isTokenRevoked(token)) {
        // ignore revoked optional token
        return next();
      }

      (req as any).authContext = decoded;
    } catch {
      // ignore invalid optional token
    }
  }
  next();
}

async function findUsersByEmail(email: string): Promise<Record<string, any>[]> {
  const searchEmail = email.toLowerCase().trim();
  const users: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;

  do {
    const scanResult: any = await ddb.send(
      new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: "email = :email",
        ExpressionAttributeValues: { ":email": searchEmail },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    if (scanResult.Items && scanResult.Items.length > 0) {
      users.push(...scanResult.Items);
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return users;
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

    // Check if email already exists (any role)
    const existingUsers = await findUsersByEmail(email);

    if (existingUsers.length > 0) {
      res.status(409).json({ error: { message: "An account with this email already exists.", status: "ALREADY_EXISTS" } });
      return;
    }

    const uid = generateUid();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    await ddb.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          uid,
          name: name.trim(),
          email: email.toLowerCase().trim(),
          phone: phone ? String(phone).trim() : null,
          role: roleInput,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    sendWelcomeEmail({
      apiKey: emailApiKey.value(),
      supportEmail: supportEmail.value(),
      appUrl: appUrl.value(),
      to: email.toLowerCase().trim(),
      userName: name.trim(),
      role: roleInput,
    }).catch((err) => console.error("Welcome email error:", err));

    const adminEmailValue = adminEmail.value();
    if (adminEmailValue) {
      sendAdminNotificationEmail({
        apiKey: emailApiKey.value(),
        supportEmail: supportEmail.value(),
        to: adminEmailValue,
        userName: name.trim(),
        email: email.toLowerCase().trim(),
        role: roleInput,
        phone: phone ? String(phone).trim() : null,
      }).catch((err) => console.error("Admin notification email error:", err));
    }

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

export async function handleCreateUser(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role || "")) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

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

    // Check if email already exists
    const existingUsers = await findUsersByEmail(email);

    if (existingUsers.length > 0) {
      res.status(409).json({ error: { message: "An account with this email already exists.", status: "ALREADY_EXISTS" } });
      return;
    }

    const uid = generateUid();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    await ddb.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          uid,
          name: name.trim(),
          email: email.toLowerCase().trim(),
          phone: phone ? String(phone).trim() : null,
          role: roleInput,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    sendWelcomeEmail({
      apiKey: emailApiKey.value(),
      supportEmail: supportEmail.value(),
      appUrl: appUrl.value(),
      to: email.toLowerCase().trim(),
      userName: name.trim(),
      role: roleInput,
    }).catch((err) => console.error("Welcome email error:", err));

    res.status(201).json({
      ok: true,
      user: {
        uid,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        phone: phone ? String(phone).trim() : null,
        role: roleInput,
      },
    });
  } catch (error: any) {
    console.error("CreateUser error:", error);
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

    // Find all users with this email and verify password against each
    const users = await findUsersByEmail(email);

    if (users.length === 0) {
      res.status(401).json({ error: { message: "Invalid email or password.", status: "UNAUTHENTICATED" } });
      return;
    }

    let matchedUser: Record<string, any> | null = null;
    for (const user of users) {
      if (user.passwordHash) {
        const valid = await verifyPassword(password, user.passwordHash);
        if (valid) {
          matchedUser = user;
          break;
        }
      }
    }

    if (!matchedUser) {
      res.status(401).json({ error: { message: "Invalid email or password.", status: "UNAUTHENTICATED" } });
      return;
    }

    const token = signToken({ uid: matchedUser.uid, email: matchedUser.email, role: matchedUser.role });

    res.json({
      ok: true,
      token,
      user: {
        uid: matchedUser.uid,
        name: matchedUser.name,
        email: matchedUser.email,
        phone: matchedUser.phone || null,
        role: matchedUser.role,
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleAdminLogin(req: Request, res: Response) {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== "string") {
      res.status(400).json({ error: { message: "username is required.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (!password || typeof password !== "string") {
      res.status(400).json({ error: { message: "password is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Hardcoded admin credentials
    if (username.trim() === "admin" && password === "admin") {
      const token = signToken({ uid: "admin-user", email: "admin", role: "admin" });
      res.json({
        ok: true,
        token,
        user: {
          uid: "admin-user",
          name: "Admin",
          email: "admin",
          phone: null,
          role: "admin",
        },
      });
      return;
    }

    res.status(401).json({ error: { message: "Invalid username or password.", status: "UNAUTHENTICATED" } });
  } catch (error: any) {
    console.error("Admin login error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleGetUser(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role || "")) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Buscar usuario
    const userResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!userResult.Item) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = userResult.Item;
    const userProfile = {
      uid: user.uid,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
      title: user.title || null,
      position: user.position || null,
      description: user.description || null,
      location: user.location || null,
      rating: user.rating || null,
      responseTime: user.responseTime || null,
      specialties: user.specialties || [],
    };

    // Buscar servicios por userId
    let services: any[] = [];
    try {
      const servicesResult = await ddb.send(
        new ScanCommand({
          TableName: SERVICES_TABLE,
          FilterExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": id },
        })
      );
      services = servicesResult.Items || [];

      // Si no hay por userId, intentar por email (legacy)
      if (services.length === 0 && user.email) {
        const emailResult = await ddb.send(
          new ScanCommand({
            TableName: SERVICES_TABLE,
            FilterExpression: "userEmail = :email",
            ExpressionAttributeValues: { ":email": user.email.toLowerCase().trim() },
          })
        );
        services = emailResult.Items || [];
      }

      // Ordenar por fecha de contratación descendente
      services.sort((a: any, b: any) => {
        const dateA = a.contractDate ? new Date(a.contractDate).getTime() : 0;
        const dateB = b.contractDate ? new Date(b.contractDate).getTime() : 0;
        return dateB - dateA;
      });
    } catch (err) {
      console.error("GetUser services error:", err);
      // No fallamos si hay error en servicios, devolvemos array vacío
    }

    const totalServices = services.length;
    const message = totalServices === 0
      ? "User has 0 services assigned"
      : `User has ${totalServices} service(s) assigned`;

    res.json({
      ok: true,
      user: userProfile,
      services: services.map((s: any) => ({
        id: s.id,
        serviceName: s.serviceName,
        serviceType: s.serviceType || null,
        policyNumber: s.policyNumber || null,
        contractDate: s.contractDate || null,
        expiryDate: s.expiryDate || null,
        status: s.status || "active",
        coverageAmount: s.coverageAmount || null,
        premiumAmount: s.premiumAmount || null,
        currency: s.currency || null,
        notes: s.notes || null,
        beneficiaryName: s.beneficiaryName || null,
        beneficiaryPhone: s.beneficiaryPhone || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      totalServices,
      message,
    });
  } catch (error: any) {
    console.error("GetUser error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleGetUserPublic(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Buscar usuario
    const userResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!userResult.Item) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = userResult.Item;
    const userProfile = {
      uid: user.uid,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
      title: user.title || null,
      position: user.position || null,
      description: user.description || null,
      location: user.location || null,
      rating: user.rating || null,
      responseTime: user.responseTime || null,
      specialties: user.specialties || [],
    };

    // Buscar servicios por userId
    let services: any[] = [];
    try {
      const servicesResult = await ddb.send(
        new ScanCommand({
          TableName: SERVICES_TABLE,
          FilterExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": id },
        })
      );
      services = servicesResult.Items || [];

      // Si no hay por userId, intentar por email (legacy)
      if (services.length === 0 && user.email) {
        const emailResult = await ddb.send(
          new ScanCommand({
            TableName: SERVICES_TABLE,
            FilterExpression: "userEmail = :email",
            ExpressionAttributeValues: { ":email": user.email.toLowerCase().trim() },
          })
        );
        services = emailResult.Items || [];
      }

      // Ordenar por fecha de contratación descendente
      services.sort((a: any, b: any) => {
        const dateA = a.contractDate ? new Date(a.contractDate).getTime() : 0;
        const dateB = b.contractDate ? new Date(b.contractDate).getTime() : 0;
        return dateB - dateA;
      });
    } catch (err) {
      console.error("GetUserPublic services error:", err);
    }

    const totalServices = services.length;
    const message = totalServices === 0
      ? "User has 0 services assigned"
      : `User has ${totalServices} service(s) assigned`;

    res.json({
      ok: true,
      user: userProfile,
      services: services.map((s: any) => ({
        id: s.id,
        serviceName: s.serviceName,
        serviceType: s.serviceType || null,
        policyNumber: s.policyNumber || null,
        contractDate: s.contractDate || null,
        expiryDate: s.expiryDate || null,
        status: s.status || "active",
        coverageAmount: s.coverageAmount || null,
        premiumAmount: s.premiumAmount || null,
        currency: s.currency || null,
        notes: s.notes || null,
        beneficiaryName: s.beneficiaryName || null,
        beneficiaryPhone: s.beneficiaryPhone || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      totalServices,
      message,
    });
  } catch (error: any) {
    console.error("GetUserPublic error:", error);
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

    const result = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: authContext.uid },
      })
    );

    if (!result.Item) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = result.Item;
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

export async function handleListUsers(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role || "")) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    const roleFilter = typeof req.query.role === "string" ? req.query.role.trim() : null;
    const validRoles = ["client", "customer", "student", "seller"];
    if (roleFilter && !validRoles.includes(roleFilter)) {
      res.status(400).json({ error: { message: `role must be one of: ${validRoles.join(", ")}.`, status: "INVALID_ARGUMENT" } });
      return;
    }

    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    const users: Record<string, any>[] = [];

    do {
      const scanResult: any = await ddb.send(
        new ScanCommand({
          TableName: USERS_TABLE,
          ...(roleFilter
            ? {
                FilterExpression: "#r = :role",
                ExpressionAttributeNames: { "#r": "role" },
                ExpressionAttributeValues: { ":role": roleFilter },
              }
            : {}),
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (scanResult.Items && scanResult.Items.length > 0) {
        users.push(...scanResult.Items);
      }

      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    res.json({
      ok: true,
      users: users.map((u) => ({
        uid: u.uid,
        name: u.name,
        email: u.email,
        phone: u.phone || null,
        role: u.role,
        title: u.title || null,
        position: u.position || null,
        description: u.description || null,
        location: u.location || null,
        rating: u.rating || null,
        specialties: u.specialties || [],
        createdAt: u.createdAt || null,
        updatedAt: u.updatedAt || null,
      })),
      total: users.length,
    });
  } catch (error: any) {
    console.error("ListUsers error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleLogout(req: Request, res: Response) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const token = authHeader.split("Bearer ")[1];

    try {
      verifyToken(token); // ensure token is valid before revoking
    } catch {
      res.status(401).json({ error: { message: "Invalid token", status: "UNAUTHENTICATED" } });
      return;
    }

    await revokeToken(token);

    res.json({ ok: true, message: "Logged out successfully" });
  } catch (error: any) {
    console.error("Logout error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleDeleteUser(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(authContext.role || "")) {
      res.status(403).json({ error: { message: "Forbidden: admin access required.", status: "PERMISSION_DENIED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Verificar que el usuario existe
    const getResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    // Eliminar el usuario
    await ddb.send(
      new DeleteCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("DeleteUser error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

export async function handleUpdateUserProfile(req: Request, res: Response) {
  try {
    const authContext = (req as any).authContext as AuthContext | undefined;
    if (!authContext) {
      res.status(401).json({ error: { message: "Unauthorized", status: "UNAUTHENTICATED" } });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Allow if admin/seller OR if editing own profile
    const isAdmin = ["seller", "admin"].includes(authContext.role || "");
    const isSelf = authContext.uid === id;
    if (!isAdmin && !isSelf) {
      res.status(403).json({ error: { message: "Forbidden: you can only edit your own profile.", status: "PERMISSION_DENIED" } });
      return;
    }

    // Verify user exists
    const getResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!getResult.Item) {
      res.status(404).json({ error: { message: "User not found.", status: "NOT_FOUND" } });
      return;
    }

    const body = req.body;
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    const stringFields: Record<string, string> = {
      name: "name",
      email: "email",
      phone: "phone",
      description: "description",
      location: "location",
      title: "title",
      position: "position",
    };

    for (const [key, attrName] of Object.entries(stringFields)) {
      if (body[key] !== undefined) {
        const safeKey = key.replace(/[^a-zA-Z0-9]/g, "");
        updateExpressions.push(`#${safeKey} = :${safeKey}`);
        expressionAttributeNames[`#${safeKey}`] = attrName;
        let value = body[key];
        if (typeof value === "string") {
          if (key === "email") {
            value = value.toLowerCase().trim();
          } else {
            value = value.trim();
          }
        }
        expressionAttributeValues[`:${safeKey}`] = value;
      }
    }

    // Specialties: array, max 5 items
    if (body.specialties !== undefined) {
      let specialties = body.specialties;
      if (typeof specialties === "string") {
        try {
          specialties = JSON.parse(specialties);
        } catch {
          specialties = [specialties];
        }
      }
      if (!Array.isArray(specialties)) {
        res.status(400).json({ error: { message: "specialties must be an array.", status: "INVALID_ARGUMENT" } });
        return;
      }
      if (specialties.length > 5) {
        res.status(400).json({ error: { message: "specialties can have at most 5 items.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#specialties = :specialties");
      expressionAttributeNames["#specialties"] = "specialties";
      expressionAttributeValues[":specialties"] = specialties.map((s: any) => String(s).trim()).filter(Boolean);
    }

    // Rating: number
    if (body.rating !== undefined) {
      const rating = typeof body.rating === "string" ? parseFloat(body.rating) : body.rating;
      if (typeof rating !== "number" || isNaN(rating) || rating < 0 || rating > 10) {
        res.status(400).json({ error: { message: "rating must be a number between 0 and 10.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#rating = :rating");
      expressionAttributeNames["#rating"] = "rating";
      expressionAttributeValues[":rating"] = rating;
    }

    // ResponseTime: number (minutes)
    if (body.responseTime !== undefined) {
      const responseTime = typeof body.responseTime === "string" ? parseInt(body.responseTime, 10) : body.responseTime;
      if (typeof responseTime !== "number" || isNaN(responseTime) || responseTime < 0) {
        res.status(400).json({ error: { message: "responseTime must be a non-negative number.", status: "INVALID_ARGUMENT" } });
        return;
      }
      updateExpressions.push("#responseTime = :responseTime");
      expressionAttributeNames["#responseTime"] = "responseTime";
      expressionAttributeValues[":responseTime"] = responseTime;
    }

    if (updateExpressions.length === 0) {
      res.json({ ok: true, id, message: "No changes to update." });
      return;
    }

    updateExpressions.push("updatedAt = :now");
    expressionAttributeValues[":now"] = new Date().toISOString();

    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
        UpdateExpression: "set " + updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    res.json({ ok: true, id });
  } catch (error: any) {
    console.error("UpdateUserProfile error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}
