import { Timestamp } from "firebase-admin/firestore";

export type UserRole = "client" | "customer" | "student" | "seller";

export type PurchaseStatus = "pending" | "paid" | "failed" | "refunded";
export type CourseAccessStatus = "active" | "revoked";

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  phone?: string | null;
  role?: UserRole | null;
  passwordHash?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface Course {
  id: string;
  title: string;
  description: string;
  /**
   * Store price in minor units to avoid floating point bugs.
   * Example: 9900 means USD 99.00.
   */
  price: number;
  currency: string;
  duration: string;
  level: string;
  lessons: number;
  /**
   * Use this only for a public preview/trailer URL.
   * Put protected video URLs in courseContent/{courseId}.
   */
  videoUrl?: string | null;
  thumbnailUrl: string;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface Purchase {
  id: string;
  userId: string;
  courseId: string;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  status: PurchaseStatus;
  amount: number;
  currency: string;
  customerEmail: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  paidAt?: Timestamp | null;
  failedAt?: Timestamp | null;
  refundedAt?: Timestamp | null;
  failureMessage?: string | null;
  confirmationEmailSentAt?: Timestamp | null;
  failedEmailSentAt?: Timestamp | null;
  refundEmailSentAt?: Timestamp | null;
}

export interface CourseAccess {
  userId: string;
  courseId: string;
  purchaseId: string;
  status: CourseAccessStatus;
  grantedAt: Timestamp;
  revokedAt?: Timestamp | null;
  updatedAt: Timestamp;
}

export interface PrivateCourseContent {
  courseId: string;
  lessons: Array<{
    id: string;
    title: string;
    duration?: string;
    videoUrl: string;
    resources?: string[];
  }>;
  updatedAt: Timestamp;
}

export type LeadRequestStatus = "pending" | "contacted" | "scheduled" | "completed" | "cancelled";

export interface LeadRequest {
  id: string;
  productId: string;
  productName: string;
  phoneNumber: string;
  customerName: string;
  customerEmail?: string | null;
  userId?: string | null;
  status: LeadRequestStatus;
  notes?: string | null;
  whatsappSentAt?: Timestamp | null;
  contactedAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
