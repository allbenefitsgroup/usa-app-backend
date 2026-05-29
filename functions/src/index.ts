import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { CallableRequest, HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import Stripe from "stripe";
import { appUrl, emailApiKey, jwtSecret, REGION, stripeSecretKey, stripeWebhookSecret, supportEmail, whatsappEnabled, whatsappPhoneNumber } from "./config";
import { db } from "./firebase";
import { sendPaymentFailedEmail, sendPurchaseConfirmation, sendRefundEmail } from "./email";
import { Course, Purchase, UserProfile } from "./models";
import { createStripeClient } from "./stripeClient";
import { sendWhatsappMessage } from "./whatsapp";
import { ddb, LEADS_TABLE, USERS_TABLE } from "./dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }

  return value.trim();
}

function timestampToMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  return null;
}

async function getPurchaseRefFromCheckoutSession(session: Stripe.Checkout.Session) {
  const purchaseId = session.metadata?.purchaseId || session.client_reference_id;
  if (purchaseId) {
    return db.collection("purchases").doc(purchaseId);
  }

  const snapshot = await db
    .collection("purchases")
    .where("stripeCheckoutSessionId", "==", session.id)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].ref;
}

async function getPurchaseRefFromPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
  const purchaseId = paymentIntent.metadata?.purchaseId;
  if (purchaseId) {
    return db.collection("purchases").doc(purchaseId);
  }

  const snapshot = await db
    .collection("purchases")
    .where("stripePaymentIntentId", "==", paymentIntent.id)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].ref;
}

async function getPurchaseRefFromCharge(charge: Stripe.Charge) {
  const purchaseId = charge.metadata?.purchaseId;
  if (purchaseId) {
    return db.collection("purchases").doc(purchaseId);
  }

  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) {
    return null;
  }

  const snapshot = await db
    .collection("purchases")
    .where("stripePaymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].ref;
}

async function sendEmailForPurchase(
  purchase: Purchase,
  kind: "confirmation" | "failed" | "refund",
  apiKey: string,
): Promise<void> {
  const [courseSnapshot, userSnapshot] = await Promise.all([
    db.collection("courses").doc(purchase.courseId).get(),
    db.collection("users").doc(purchase.userId).get(),
  ]);

  const course = courseSnapshot.data() as Course | undefined;
  const user = userSnapshot.data() as UserProfile | undefined;

  if (!course) {
    logger.warn("Email skipped because course no longer exists.", {
      courseId: purchase.courseId,
      purchaseId: purchase.id,
    });
    return;
  }

  const payload = {
    apiKey,
    supportEmail: supportEmail.value(),
    appUrl: appUrl.value(),
    to: purchase.customerEmail,
    userName: user?.name,
    courseTitle: course.title,
    courseId: purchase.courseId,
    amount: purchase.amount,
    currency: purchase.currency,
  };

  if (kind === "confirmation") {
    await sendPurchaseConfirmation(payload);
  } else if (kind === "failed") {
    await sendPaymentFailedEmail(payload);
  } else {
    await sendRefundEmail(payload);
  }
}

export async function handleSyncUserProfile(request: ApiRequest<SyncUserProfileInput>) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const authContext = request.auth;
  const data = (request.data || {}) as SyncUserProfileInput;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const phone = typeof data.phone === "string" ? data.phone.trim() : data.phone ?? null;
  const roleInput = typeof data.role === "string" ? data.role.trim() : null;

  if (!name) {
    throw new HttpsError("invalid-argument", "name is required.");
  }

  const validRoles: string[] = ["client", "customer", "student", "seller"];

  const userRef = db.collection("users").doc(authContext.uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const existingProfile = snapshot.exists ? (snapshot.data() as UserProfile) : null;
    const currentRole = existingProfile?.role ?? null;

    let roleToSet: string | null = currentRole;

    if (!currentRole) {
      if (!roleInput || !validRoles.includes(roleInput)) {
        throw new HttpsError("invalid-argument", `role is required on first sync and must be one of: ${validRoles.join(", ")}.`);
      }
      roleToSet = roleInput;
    } else if (roleInput && roleInput !== currentRole) {
      throw new HttpsError("failed-precondition", "Role cannot be changed once set.");
    }

    const profile = {
      uid: authContext.uid,
      name,
      email: existingProfile?.email || authContext.email || "",
      phone: phone || null,
      role: roleToSet,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (snapshot.exists) {
      transaction.set(userRef, profile, { merge: true });
    } else {
      transaction.set(userRef, {
        ...profile,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { ok: true };
}

function wrapOnCall<T>(handler: (req: ApiRequest<T>) => Promise<any>) {
  return async (request: CallableRequest<T>) => {
    const apiRequest: ApiRequest<T> = {
      data: request.data,
      auth: request.auth ? { uid: request.auth.uid, email: request.auth.token.email } : undefined,
      rawRequest: request.rawRequest,
    };
    return handler(apiRequest);
  };
}

export const syncUserProfile = onCall(
  {
    region: REGION,
  },
  wrapOnCall(handleSyncUserProfile),
);

export async function handleCreateCheckoutSession(request: ApiRequest<CreateCheckoutSessionInput>) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const data = (request.data || {}) as CreateCheckoutSessionInput;
  const userId = assertString(data.userId, "userId");
  const courseId = assertString(data.courseId, "courseId");

  if (userId !== request.auth.uid) {
    throw new HttpsError("permission-denied", "You can only create checkout for your own user.");
  }

  const [userSnapshot, courseSnapshot] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("courses").doc(courseId).get(),
  ]);

  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "User was not found.");
  }

  const user = userSnapshot.data() as UserProfile;

  if (!user.email) {
    throw new HttpsError("failed-precondition", "The user must have an email address.");
  }

  if (!courseSnapshot.exists) {
    throw new HttpsError("not-found", "Course was not found.");
  }

  const course = courseSnapshot.data() as Course;

  if (!course.isActive) {
    throw new HttpsError("failed-precondition", "Course is not available for purchase.");
  }

  if (!Number.isInteger(course.price) || course.price <= 0) {
    throw new HttpsError("failed-precondition", "Course price is invalid.");
  }

  const purchaseRef = db.collection("purchases").doc();
  const now = FieldValue.serverTimestamp();

  await purchaseRef.set({
    id: purchaseRef.id,
    userId,
    courseId,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    status: "pending",
    amount: course.price,
    currency: course.currency.toLowerCase(),
    customerEmail: user.email,
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    failedAt: null,
    refundedAt: null,
  });

  const stripe = createStripeClient(stripeSecretKey.value());
  const baseUrl = (appUrl.value() || "https://your-app.example.com").replace(/\/$/, "");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: purchaseRef.id,
      customer_email: user.email,
      success_url: `${baseUrl}/learn/course/${encodeURIComponent(courseId)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/learn/course/${encodeURIComponent(courseId)}?checkout=cancelled`,
      metadata: {
        purchaseId: purchaseRef.id,
        userId,
        courseId,
      },
      payment_intent_data: {
        metadata: {
          purchaseId: purchaseRef.id,
          userId,
          courseId,
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: course.currency.toLowerCase(),
            unit_amount: course.price,
            product_data: {
              name: course.title,
              description: course.description,
              images: course.thumbnailUrl ? [course.thumbnailUrl] : undefined,
              metadata: {
                courseId,
              },
            },
          },
        },
      ],
    });

    await purchaseRef.update({
      stripeCheckoutSessionId: session.id,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (!session.url) {
      throw new HttpsError("internal", "Stripe did not return a checkout URL.");
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      purchaseId: purchaseRef.id,
    };
  } catch (error) {
    await purchaseRef.update({
      status: "failed",
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      failureMessage: error instanceof Error ? error.message : "Stripe checkout creation failed.",
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    logger.error("Failed to create Stripe Checkout Session.", error);
    throw new HttpsError("internal", "Could not create checkout session.");
  }
}

export const createCheckoutSession = onCall(
  {
    region: REGION,
    secrets: [stripeSecretKey] as any,
  },
  wrapOnCall(handleCreateCheckoutSession),
);

export async function handleGetMyCourseAccess(request: ApiRequest<unknown>) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const purchasesSnapshot = await db
    .collection("purchases")
    .where("userId", "==", request.auth.uid)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const courseIds = [...new Set(purchasesSnapshot.docs.map((doc) => (doc.data() as Purchase).courseId))];
  const courseSnapshots = await Promise.all(courseIds.map((courseId) => db.collection("courses").doc(courseId).get()));
  const coursesById = new Map(courseSnapshots.map((snapshot) => [snapshot.id, snapshot.data() as Course | undefined]));

  return {
    purchases: purchasesSnapshot.docs.map((doc) => {
      const purchase = doc.data() as Purchase;
      const course = coursesById.get(purchase.courseId);

      return {
        id: doc.id,
        userId: purchase.userId,
        courseId: purchase.courseId,
        status: purchase.status,
        amount: purchase.amount,
        currency: purchase.currency,
        customerEmail: purchase.customerEmail,
        createdAt: timestampToMillis(purchase.createdAt),
        paidAt: timestampToMillis(purchase.paidAt),
        course: course
          ? {
              id: purchase.courseId,
              title: course.title,
              description: course.description,
              duration: course.duration,
              level: course.level,
              lessons: course.lessons,
              thumbnailUrl: course.thumbnailUrl,
            }
          : null,
        canViewContent: purchase.status === "paid",
      };
    }),
  };
}

export const getMyCourseAccess = onCall(
  {
    region: REGION,
  },
  wrapOnCall(handleGetMyCourseAccess),
);

export async function handleStripeWebhook(request: any, response: any) {
  if (request.method !== "POST") {
    response.status(405).send("Method Not Allowed");
    return;
  }

  const stripe = createStripeClient(stripeSecretKey.value());
  const signature = request.header("stripe-signature");
  const rawBody = (request as typeof request & { rawBody?: Buffer }).rawBody;

  if (!signature || !rawBody) {
    response.status(400).send("Missing Stripe signature or raw body.");
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret.value());
  } catch (error) {
    logger.warn("Invalid Stripe webhook signature.", error);
    response.status(400).send("Invalid signature.");
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.payment_status !== "paid") {
        logger.info("Checkout session completed without paid payment status.", {
          sessionId: session.id,
          paymentStatus: session.payment_status,
        });
        response.status(200).send("ok");
        return;
      }

      const purchaseRef = await getPurchaseRefFromCheckoutSession(session);

      if (!purchaseRef) {
        logger.warn("Purchase not found for checkout session.", { sessionId: session.id });
        response.status(200).send("ok");
        return;
      }

      let purchaseAfterUpdate: Purchase | null = null;
      let shouldSendConfirmationEmail = false;

      await db.runTransaction(async (transaction) => {
        const purchaseSnapshot = await transaction.get(purchaseRef);

        if (!purchaseSnapshot.exists) {
          return;
        }

        const purchase = purchaseSnapshot.data() as Purchase;
        const paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
        const sessionCurrency = session.currency?.toLowerCase();

        if (session.amount_total !== purchase.amount || sessionCurrency !== purchase.currency.toLowerCase()) {
          throw new Error(`Stripe amount/currency mismatch for purchase ${purchaseSnapshot.id}.`);
        }

        shouldSendConfirmationEmail = !purchase.confirmationEmailSentAt;

        transaction.update(purchaseRef, {
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          status: "paid",
          paidAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        const accessRef = db.collection("users").doc(purchase.userId).collection("courseAccess").doc(purchase.courseId);

        transaction.set(
          accessRef,
          {
            userId: purchase.userId,
            courseId: purchase.courseId,
            purchaseId: purchaseSnapshot.id,
            status: "active",
            grantedAt: FieldValue.serverTimestamp(),
            revokedAt: null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        purchaseAfterUpdate = {
          ...purchase,
          id: purchaseSnapshot.id,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          status: "paid",
        };
      });

      if (purchaseAfterUpdate && shouldSendConfirmationEmail) {
        await sendEmailForPurchase(purchaseAfterUpdate, "confirmation", emailApiKey.value());
        await purchaseRef.update({
          confirmationEmailSentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const purchaseRef = await getPurchaseRefFromPaymentIntent(paymentIntent);

      if (purchaseRef) {
        const snapshot = await purchaseRef.get();
        const purchase = snapshot.data() as Purchase | undefined;

        if (purchase?.status === "paid" || purchase?.status === "refunded") {
          response.status(200).send("ok");
          return;
        }

        await purchaseRef.update({
          stripePaymentIntentId: paymentIntent.id,
          status: "failed",
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          failureMessage: paymentIntent.last_payment_error?.message || "Payment failed.",
        });

        if (purchase && !purchase.failedEmailSentAt) {
          await sendEmailForPurchase({ ...purchase, id: snapshot.id, status: "failed" }, "failed", emailApiKey.value());
          await purchaseRef.update({
            failedEmailSentAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const purchaseRef = await getPurchaseRefFromCharge(charge);

      if (purchaseRef) {
        let purchaseAfterUpdate: Purchase | null = null;
        let shouldSendRefundEmail = false;

        await db.runTransaction(async (transaction) => {
          const purchaseSnapshot = await transaction.get(purchaseRef);

          if (!purchaseSnapshot.exists) {
            return;
          }

          const purchase = purchaseSnapshot.data() as Purchase;
          shouldSendRefundEmail = !purchase.refundEmailSentAt;

          transaction.update(purchaseRef, {
            status: "refunded",
            refundedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          const accessRef = db.collection("users").doc(purchase.userId).collection("courseAccess").doc(purchase.courseId);

          transaction.set(
            accessRef,
            {
              status: "revoked",
              revokedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );

          purchaseAfterUpdate = { ...purchase, id: purchaseSnapshot.id, status: "refunded" };
        });

        if (purchaseAfterUpdate && shouldSendRefundEmail) {
          await sendEmailForPurchase(purchaseAfterUpdate, "refund", emailApiKey.value());
          await purchaseRef.update({
            refundEmailSentAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    } else {
      logger.info("Unhandled Stripe webhook event.", { type: event.type });
    }

    response.status(200).send("ok");
  } catch (error) {
    logger.error("Stripe webhook failed.", error);
    response.status(500).send("Webhook handler failed.");
  }
}

export const stripeWebhook = onRequest(
  {
    region: REGION,
    secrets: [stripeSecretKey, stripeWebhookSecret, emailApiKey] as any,
  },
  handleStripeWebhook,
);

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
    throw new HttpsError("invalid-argument", "Invalid phone number format.");
  }

  const vendorPhone = whatsappPhoneNumber.value().replace(/\D/g, "");
  if (!vendorPhone) {
    throw new HttpsError("unavailable", "WhatsApp phone number is not configured.");
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
    throw new HttpsError("invalid-argument", "customerName is required when not authenticated.");
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

    logger.info("Lead created and WhatsApp link generated", { leadId, productId, vendorPhone });

    return {
      ok: true,
      leadId,
      whatsappUrl,
      vendorPhone,
      message: "Lead guardado. Abrí el enlace de WhatsApp para contactar al vendedor.",
    };
  } catch (error) {
    logger.error("Failed to create lead request", error);
    throw new HttpsError("internal", "Could not process your request.");
  }
}

export const requestProductInfo = onCall(
  {
    region: REGION,
  },
  wrapOnCall(handleRequestProductInfo),
);

type SendWhatsappMessageInput = {
  phoneNumber?: string;
  message?: string;
};

export async function handleSendWhatsappNotification(request: ApiRequest<SendWhatsappMessageInput>) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  if (whatsappEnabled.value() !== "true") {
    throw new HttpsError("unavailable", "WhatsApp notifications are not enabled.");
  }

  const data = (request.data || {}) as SendWhatsappMessageInput;
  const phoneNumber = assertString(data.phoneNumber, "phoneNumber");
  const message = assertString(data.message, "message");

  // Validate phone number format (basic validation)
  if (!/^\+?[\d\s\-()]+$/.test(phoneNumber) || phoneNumber.replace(/\D/g, "").length < 10) {
    throw new HttpsError("invalid-argument", "Invalid phone number format.");
  }

  try {
    const success = await sendWhatsappMessage(phoneNumber, message);

    if (!success) {
      throw new HttpsError("internal", "Failed to send WhatsApp message.");
    }

    return { ok: true, message: "WhatsApp message sent successfully" };
  } catch (error) {
    logger.error("Failed to send WhatsApp notification", error);
    throw new HttpsError("internal", "Could not send WhatsApp message.");
  }
}

export const sendWhatsappNotification = onCall(
  {
    region: REGION,
  },
  wrapOnCall(handleSendWhatsappNotification),
);
