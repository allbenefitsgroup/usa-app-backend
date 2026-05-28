import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { auth as authV1 } from "firebase-functions/v1";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import Stripe from "stripe";
import { appUrl, emailApiKey, REGION, stripeSecretKey, stripeWebhookSecret, supportEmail, whatsappEnabled } from "./config";
import { auth, db } from "./firebase";
import { sendPaymentFailedEmail, sendPurchaseConfirmation, sendRefundEmail } from "./email";
import { Course, Purchase, UserProfile, LeadRequest } from "./models";
import { createStripeClient } from "./stripeClient";
import { sendWhatsappMessage } from "./whatsapp";

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

export const createUserProfile = authV1.user().onCreate(async (user) => {
  const userRef = db.collection("users").doc(user.uid);
  const snapshot = await userRef.get();

  if (snapshot.exists) {
    return;
  }

  await userRef.set({
    uid: user.uid,
    name: user.displayName || "",
    email: user.email || "",
    phone: user.phoneNumber || null,
    role: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
});

export const syncUserProfile = onCall(
  {
    region: REGION,
  },
  async (request) => {
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

    const validRoles: string[] = ["client", "customer", "student"];

    const userRecord = await auth.getUser(authContext.uid);

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
        email: userRecord.email || authContext.token.email || "",
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
  },
);

export const createCheckoutSession = onCall(
  {
    region: REGION,
    secrets: [stripeSecretKey],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const data = (request.data || {}) as CreateCheckoutSessionInput;
    const userId = assertString(data.userId, "userId");
    const courseId = assertString(data.courseId, "courseId");

    if (userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "You can only create checkout for your own user.");
    }

    const [userRecord, courseSnapshot] = await Promise.all([
      auth.getUser(userId),
      db.collection("courses").doc(courseId).get(),
    ]);

    if (!userRecord.email) {
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
      customerEmail: userRecord.email,
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
        customer_email: userRecord.email,
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
  },
);

export const getMyCourseAccess = onCall(
  {
    region: REGION,
  },
  async (request) => {
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
  },
);

export const stripeWebhook = onRequest(
  {
    region: REGION,
    secrets: [stripeSecretKey, stripeWebhookSecret, emailApiKey],
  },
  async (request, response) => {
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
  },
);

type RequestProductInfoInput = {
  productId?: string;
  productName?: string;
  phoneNumber?: string;
  customerName?: string;
  customerEmail?: string | null;
};

export const requestProductInfo = onCall(
  {
    region: REGION,
  },
  async (request) => {
    const data = (request.data || {}) as RequestProductInfoInput;
    const productId = assertString(data.productId, "productId");
    const productName = assertString(data.productName, "productName");
    const phoneNumber = assertString(data.phoneNumber, "phoneNumber");
    const customerName = assertString(data.customerName, "customerName");

    // Validate phone number format
    if (!/^\+?[\d\s\-()]+$/.test(phoneNumber) || phoneNumber.replace(/\D/g, "").length < 10) {
      throw new HttpsError("invalid-argument", "Invalid phone number format.");
    }

    if (whatsappEnabled.value() !== "true") {
      throw new HttpsError("unavailable", "WhatsApp service is not available.");
    }

    try {
      const leadRef = db.collection("leads").doc();
      const now = FieldValue.serverTimestamp();

      await leadRef.set({
        id: leadRef.id,
        productId,
        productName,
        phoneNumber,
        customerName,
        customerEmail: data.customerEmail || null,
        userId: request.auth?.uid || null,
        status: "pending",
        notes: null,
        whatsappSentAt: null,
        contactedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const whatsappMessage = `Hola ${customerName}, has solicitado información sobre ${productName}. En breves se comunicará un agente para brindarte más detalles. ¡Gracias!`;

      const whatsappSuccess = await sendWhatsappMessage(phoneNumber, whatsappMessage);

      if (whatsappSuccess) {
        await leadRef.update({
          whatsappSentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        logger.warn("WhatsApp message failed but lead was created", { leadId: leadRef.id });
      }

      return {
        ok: true,
        leadId: leadRef.id,
        message: "Lead creado. Se envió confirmación por WhatsApp.",
      };
    } catch (error) {
      logger.error("Failed to create lead request", error);
      throw new HttpsError("internal", "Could not process your request.");
    }
  },
);

type SendWhatsappMessageInput = {
  phoneNumber?: string;
  message?: string;
};

export const sendWhatsappNotification = onCall(
  {
    region: REGION,
  },
  async (request) => {
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
  },
);
