export type Timestamp = string;

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
  description?: string | null;
  location?: string | null;
  title?: string | null;
  position?: string | null;
  specialties?: string[] | null;
  startDate?: Timestamp | null;
  rating?: number | null;
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

export type RecommendationType = "instagram" | "youtube" | "general";

export interface Recommendation {
  id: string;
  title: string;
  subtitle: string;
  type: RecommendationType;
  externalUrl?: string | null;
  imageUrl?: string | null;
  color?: string | null;
  icon?: string | null;
  ctaLabel?: string | null;
  ctaLink?: string | null;
  active: boolean;
  order: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type ServiceStatus = "active" | "expired" | "cancelled" | "pending";

export interface ClientService {
  id: string;
  userId: string;
  userEmail?: string | null;
  serviceName: string;
  serviceType?: string | null;
  policyNumber?: string | null;
  contractDate: Timestamp;
  expiryDate?: Timestamp | null;
  status: ServiceStatus;
  coverageAmount?: number | null;
  premiumAmount?: number | null;
  currency?: string | null;
  notes?: string | null;
  beneficiaryName?: string | null;
  beneficiaryPhone?: string | null;
  catalogItemId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ServiceCatalogItem {
  id: string;
  name: string;
  type?: string | null;
  description?: string | null;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
