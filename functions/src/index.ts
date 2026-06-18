import Stripe from "stripe";
import {
  appUrl,
  emailApiKey,
  jwtSecret,
  stripeSecretKey,
  stripeWebhookSecret,
  supportEmail,
  whatsappEnabled,
  whatsappPhoneNumber,
} from "./config";
import { sendPaymentFailedEmail, sendPurchaseConfirmation, sendRefundEmail } from "./email";
import { Course, Purchase, UserProfile } from "./models";
import { createStripeClient } from "./stripeClient";
import { sendWhatsappMessage } from "./whatsapp";
import { ddb, LEADS_TABLE, USERS_TABLE, RECOMMENDATIONS_TABLE } from "./dynamodb";
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { generateUid } from "./auth";

export type ApiAuth = {
  uid: string;
  email?: string;
  token?: any;
};

export type ApiRequest<T = any> = {
  data: T;
  auth?: ApiAuth;
  rawRequest?: any;
};

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
  }
}

type CreateCheckoutSessionInput = {
  userId?: string;
  courseId?: string;
};

type SyncUserProfileInput = {
  name?: string;
  phone?: string | null;
  role?: string | null;
};

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("invalid-argument", `${fieldName} is required.`);
  }
  return value.trim();
}

function timestampToMillis(value: unknown): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

// Placeholders for Firestore-dependent features (to be migrated to DynamoDB)
async function getPurchaseRefFromCheckoutSession(_session: Stripe.Checkout.Session) {
  throw new ApiError("internal", "Firestore feature not yet migrated to DynamoDB.");
}

async function getPurchaseRefFromPaymentIntent(_paymentIntent: Stripe.PaymentIntent) {
  throw new ApiError("internal", "Firestore feature not yet migrated to DynamoDB.");
}

async function getPurchaseRefFromCharge(_charge: Stripe.Charge) {
  throw new ApiError("internal", "Firestore feature not yet migrated to DynamoDB.");
}

async function sendEmailForPurchase(
  _purchase: Purchase,
  _kind: "confirmation" | "failed" | "refund",
  _apiKey: string,
): Promise<void> {
  throw new ApiError("internal", "Firestore feature not yet migrated to DynamoDB.");
}

export async function handleSyncUserProfile(request: ApiRequest<SyncUserProfileInput>) {
  if (!request.auth) {
    throw new ApiError("unauthenticated", "You must be signed in.");
  }
  throw new ApiError("internal", "User profile sync not yet migrated to DynamoDB.");
}

export async function handleCreateCheckoutSession(request: ApiRequest<CreateCheckoutSessionInput>) {
  if (!request.auth) {
    throw new ApiError("unauthenticated", "You must be signed in.");
  }
  throw new ApiError("internal", "Checkout session creation not yet migrated to DynamoDB.");
}

export async function handleGetMyCourseAccess(request: ApiRequest<unknown>) {
  if (!request.auth) {
    throw new ApiError("unauthenticated", "You must be signed in.");
  }
  throw new ApiError("internal", "Course access not yet migrated to DynamoDB.");
}

export async function handleStripeWebhook(_request: any, response: any) {
  response.status(500).send("Stripe webhook handler requires Firestore migration to DynamoDB.");
}

type RequestProductInfoInput = {
  productId?: string;
  productName?: string;
  phoneNumber?: string;
  customerName?: string;
  customerEmail?: string | null;
};

export async function handleRequestProductInfo(request: ApiRequest<RequestProductInfoInput>) {
  const data = (request.data || {}) as RequestProductInfoInput;
  const productId = assertString(data.productId, "productId");
  const productName = assertString(data.productName, "productName");
  const phoneNumber = assertString(data.phoneNumber, "phoneNumber");

  // Validate phone number format
  if (!/^\+?[\d\s\-()]+$/.test(phoneNumber) || phoneNumber.replace(/\D/g, "").length < 10) {
    throw new ApiError("invalid-argument", "Invalid phone number format.");
  }

  const vendorPhone = whatsappPhoneNumber.value().replace(/\D/g, "");
  if (!vendorPhone) {
    throw new ApiError("unavailable", "WhatsApp phone number is not configured.");
  }

  let customerName = data.customerName?.trim() || "";

  // If user is authenticated and no name provided, fetch from profile
  if (!customerName && request.auth?.uid) {
    const userResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: request.auth.uid },
      })
    );
    if (userResult.Item?.name) {
      customerName = userResult.Item.name as string;
    }
  }

  if (!customerName) {
    throw new ApiError("invalid-argument", "customerName is required when not authenticated.");
  }

  try {
    const leadId = generateUid();
    const now = new Date().toISOString();

    // Save lead to DynamoDB
    await ddb.send(
      new PutCommand({
        TableName: LEADS_TABLE,
        Item: {
          leadId,
          productId,
          productName,
          customerPhone: phoneNumber.replace(/\D/g, ""),
          customerName,
          customerEmail: data.customerEmail || null,
          userId: request.auth?.uid || null,
          status: "pending",
          contactedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    // Build pre-filled WhatsApp message
    const message = `Hola, me interesa obtener más información sobre: ${productName}. Mi nombre es ${customerName}.`;
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/${vendorPhone}?text=${encodedMessage}`;

    console.log("Lead created and WhatsApp link generated", { leadId, productId, vendorPhone });

    return {
      ok: true,
      leadId,
      whatsappUrl,
      vendorPhone,
      message: "Lead guardado. Abrí el enlace de WhatsApp para contactar al vendedor.",
    };
  } catch (error) {
    console.error("Failed to create lead request", error);
    throw new ApiError("internal", "Could not process your request.");
  }
}

type SendWhatsappMessageInput = {
  phoneNumber?: string;
  message?: string;
};

export async function handleSendWhatsappNotification(request: ApiRequest<SendWhatsappMessageInput>) {
  if (!request.auth) {
    throw new ApiError("unauthenticated", "You must be signed in.");
  }

  if (whatsappEnabled.value() !== "true") {
    throw new ApiError("unavailable", "WhatsApp notifications are not enabled.");
  }

  const data = (request.data || {}) as SendWhatsappMessageInput;
  const phoneNumber = assertString(data.phoneNumber, "phoneNumber");
  const message = assertString(data.message, "message");

  // Validate phone number format (basic validation)
  if (!/^\+?[\d\s\-()]+$/.test(phoneNumber) || phoneNumber.replace(/\D/g, "").length < 10) {
    throw new ApiError("invalid-argument", "Invalid phone number format.");
  }

  try {
    const success = await sendWhatsappMessage(phoneNumber, message);

    if (!success) {
      throw new ApiError("internal", "Failed to send WhatsApp message.");
    }

    return { ok: true, message: "WhatsApp message sent successfully" };
  } catch (error) {
    console.error("Failed to send WhatsApp notification", error);
    throw new ApiError("internal", "Could not send WhatsApp message.");
  }
}

function getSixHourBlock(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const block = Math.floor(hour / 6);
  // Unique block index since epoch-like reference: days since a fixed point + block
  const startYear = 2024;
  const daysSinceStart = (year - startYear) * 365 + month * 30 + day;
  return daysSinceStart * 4 + block;
}

export async function handleGetRecommendations() {
  const now = new Date();

  // Try to load active recommendations from DynamoDB first
  let items: Array<{
    id: string;
    title: string;
    type: string;
    imageUrl?: string | null;
    ctaLink?: string | null;
    active?: boolean;
  }> = [];

  try {
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    const dbItems: any[] = [];

    do {
      const scanResult: any = await ddb.send(
        new ScanCommand({
          TableName: RECOMMENDATIONS_TABLE,
          FilterExpression: "active = :active",
          ExpressionAttributeValues: { ":active": true },
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (scanResult.Items) {
        dbItems.push(...scanResult.Items);
      }
      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (dbItems.length > 0) {
      items = dbItems
        .map((data) => ({
          id: String(data.id || ""),
          title: typeof data.title === "string" ? data.title : "",
          type: typeof data.type === "string" ? data.type : "general",
          imageUrl: data.imageUrl || null,
          ctaLink: data.ctaLink || null,
          active: data.active ?? true,
          order: typeof data.order === "number" ? data.order : 0,
        }))
        .sort((a, b) => a.order - b.order);
    }
  } catch (err) {
    console.warn("Failed to load recommendations from DynamoDB.", err);
  }

  const source = items;

  const blockIndex = getSixHourBlock(now);
  const shift = source.length > 0 ? blockIndex % source.length : 0;

  // Rotate so the current block's recommendation is first, preserving order
  const rotated = [
    ...source.slice(shift),
    ...source.slice(0, shift),
  ];

  return {
    recommendations: rotated.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      imageUrl: r.imageUrl || null,
      ctaLink: r.ctaLink || null,
      active: r.active ?? true,
    })),
    activeIndex: 0,
    total: source.length,
    updatedAt: now.toISOString(),
  };
}

// Admin CRUD for recommendations using DynamoDB
export async function handleListRecommendations() {
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  const dbItems: any[] = [];

  do {
    const scanResult: any = await ddb.send(
      new ScanCommand({
        TableName: RECOMMENDATIONS_TABLE,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    if (scanResult.Items) {
      dbItems.push(...scanResult.Items);
    }
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  dbItems.sort((a, b) => (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0));

  return {
    recommendations: dbItems.map((data) => ({
      id: String(data.id || ""),
      title: data.title || "",
      type: data.type || "general",
      externalUrl: data.externalUrl || null,
      imageUrl: data.imageUrl || null,
      ctaLink: data.ctaLink || null,
      active: !!data.active,
      order: typeof data.order === "number" ? data.order : 0,
      createdAt: data.createdAt || null,
    })),
  };
}

type CreateRecommendationInput = {
  title?: string;
  type?: string;
  imageUrl?: string | null;
  ctaLink?: string | null;
  active?: boolean;
};

export async function handleCreateRecommendation(request: ApiRequest<CreateRecommendationInput>) {
  const data = request.data || {};
  const title = typeof data.title === "string" ? data.title.trim() : "";

  if (!title) {
    throw new ApiError("invalid-argument", "title is required.");
  }

  const type = typeof data.type === "string" ? data.type.trim() : "general";
  const validTypes = ["instagram", "youtube", "general"];
  if (!validTypes.includes(type)) {
    throw new ApiError("invalid-argument", `type must be one of: ${validTypes.join(", ")}.`);
  }

  // Assign order at the end so new items appear last
  let nextOrder = 1;
  try {
    let lastKey: Record<string, any> | undefined = undefined;
    let count = 0;
    do {
      const scanResult: any = await ddb.send(
        new ScanCommand({
          TableName: RECOMMENDATIONS_TABLE,
          ExclusiveStartKey: lastKey,
        })
      );
      count += (scanResult.Items || []).length;
      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);
    nextOrder = count + 1;
  } catch {
    // fallback to 1 if scan fails
  }

  const id = generateUid();
  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Item: {
        id,
        title,
        type,
        imageUrl: data.imageUrl || null,
        ctaLink: data.ctaLink || null,
        active: typeof data.active === "boolean" ? data.active : true,
        order: nextOrder,
        createdAt: now,
        updatedAt: now,
      },
    })
  );

  return { ok: true, id };
}

type UpdateRecommendationInput = {
  id?: string;
  title?: string;
  type?: string;
  imageUrl?: string | null;
  ctaLink?: string | null;
  active?: boolean;
};

export async function handleUpdateRecommendation(request: ApiRequest<UpdateRecommendationInput>) {
  const data = request.data || {};
  const id = assertString(data.id, "id");

  // Check existence
  const getResult = await ddb.send(
    new GetCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: { id },
    })
  );
  if (!getResult.Item) {
    throw new ApiError("not-found", "Recommendation not found.");
  }

  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  if (typeof data.title === "string") {
    updateExpressions.push("#t = :t");
    expressionAttributeNames["#t"] = "title";
    expressionAttributeValues[":t"] = data.title.trim();
  }
  if (typeof data.type === "string") {
    const validTypes = ["instagram", "youtube", "general"];
    if (!validTypes.includes(data.type)) {
      throw new ApiError("invalid-argument", `type must be one of: ${validTypes.join(", ")}.`);
    }
    updateExpressions.push("#ty = :ty");
    expressionAttributeNames["#ty"] = "type";
    expressionAttributeValues[":ty"] = data.type.trim();
  }
  if (data.imageUrl !== undefined) {
    updateExpressions.push("#iu = :iu");
    expressionAttributeNames["#iu"] = "imageUrl";
    expressionAttributeValues[":iu"] = data.imageUrl;
  }
  if (data.ctaLink !== undefined) {
    updateExpressions.push("#clink = :clink");
    expressionAttributeNames["#clink"] = "ctaLink";
    expressionAttributeValues[":clink"] = data.ctaLink;
  }
  if (typeof data.active === "boolean") {
    updateExpressions.push("#a = :a");
    expressionAttributeNames["#a"] = "active";
    expressionAttributeValues[":a"] = data.active;
  }

  if (updateExpressions.length === 0) {
    return { ok: true, id };
  }

  updateExpressions.push("updatedAt = :now");
  expressionAttributeValues[":now"] = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: { id },
      UpdateExpression: "set " + updateExpressions.join(", "),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return { ok: true, id };
}

export async function handleDeleteRecommendation(request: ApiRequest<{ id?: string }>) {
  const data = request.data || {};
  const id = assertString(data.id, "id");

  // Check existence
  const getResult = await ddb.send(
    new GetCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: { id },
    })
  );
  if (!getResult.Item) {
    throw new ApiError("not-found", "Recommendation not found.");
  }

  await ddb.send(
    new DeleteCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: { id },
    })
  );

  return { ok: true, id };
}

type ReorderItem = { id: string; order: number };
type ReorderRecommendationsInput = {
  items?: ReorderItem[];
};

export async function handleReorderRecommendations(request: ApiRequest<ReorderRecommendationsInput>) {
  const data = request.data || {};
  const items = Array.isArray(data.items) ? data.items : [];

  if (items.length === 0) {
    throw new ApiError("invalid-argument", "items array is required.");
  }

  const now = new Date().toISOString();

  for (const item of items) {
    if (!item.id || typeof item.id !== "string") {
      throw new ApiError("invalid-argument", "Each item must have a valid id.");
    }
    if (typeof item.order !== "number") {
      throw new ApiError("invalid-argument", "Each item must have a valid order number.");
    }

    await ddb.send(
      new UpdateCommand({
        TableName: RECOMMENDATIONS_TABLE,
        Key: { id: item.id },
        UpdateExpression: "set #o = :o, updatedAt = :now",
        ExpressionAttributeNames: { "#o": "order" },
        ExpressionAttributeValues: { ":o": item.order, ":now": now },
      })
    );
  }

  return { ok: true, updated: items.length };
}
