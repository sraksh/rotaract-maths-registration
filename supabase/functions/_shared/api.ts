/** Wire types shared by the Edge Functions and the frontend (types only). */
import type { ExamSchedule } from './schedule.ts';

export type PaymentStatus = 'pending' | 'verified' | 'rejected';

export interface PublicConfig {
  event: {
    name: string;
    organiser: string;
    /** YYYY-MM-DD */
    date: string;
    venue: string | null;
    venueConfirmed: boolean;
  };
  registrationOpen: boolean;
  paymentReady: boolean;
  /** Names of essential settings that are still missing. */
  missing: string[];
  /** null until every payment setting is configured. */
  payment: { fee: number; payeeName: string; upiId: string; qrImagePath: string } | null;
  schools: string[];
  schedules: ExamSchedule[];
  limits: { maxProofBytes: number };
}

export interface Receipt {
  registrationId: string;
  fullName: string;
  schoolName: string;
  classLevel: number;
  shift: number;
  examDate: string;
  examStart: string;
  examEnd: string;
  reportingTime: string;
  paymentStatus: PaymentStatus;
  createdAt: string;
}

export interface InitUploadResult {
  replay: boolean;
  /** Present when replay is true: the registration was already saved. */
  registration?: Receipt;
  uploadSessionId?: string;
  bucket?: string;
  path?: string;
  token?: string;
  expiresAt?: string;
  maxBytes?: number;
}

export interface SubmitResult {
  registration: Receipt;
  replayed: boolean;
}

export interface RegistrationRow {
  registrationId: string;
  fullName: string;
  schoolName: string;
  rollNumber: string;
  mobile: string;
  classLevel: number;
  shift: number;
  examStart: string;
  examEnd: string;
  reportingTime: string;
  createdAt: string;
  paymentStatus: PaymentStatus;
  hasProof: boolean;
}

export interface RegistrationFilters {
  q?: string;
  classLevel?: number;
  school?: string;
  status?: PaymentStatus;
  /** YYYY-MM-DD, interpreted in Asia/Kolkata */
  from?: string;
  to?: string;
}

export interface ListResult {
  rows: RegistrationRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditEvent {
  id: number;
  createdAt: string;
  action: string;
  actorEmail: string | null;
  previousStatus: PaymentStatus | null;
  newStatus: PaymentStatus | null;
  reason: string | null;
  note: string | null;
}

export interface RegistrationDetail extends Omit<RegistrationRow, 'hasProof'> {
  examDate: string;
  hasProof: boolean;
  proofContentType: string;
  proofSizeBytes: number;
  paymentNote: string | null;
  paymentRejectReason: string | null;
  paymentReviewedAt: string | null;
  paymentReviewedByEmail: string | null;
  declarationAccepted: boolean;
  declarationAcceptedAt: string;
  updatedAt: string;
  history: AuditEvent[];
}

export interface StatsResult {
  total: number;
  pending: number;
  verified: number;
  rejected: number;
  stalePending: number;
  attention: number;
  staleHours: number;
  byClass: { classLevel: number; shift: number; count: number }[];
  bySchool: { school: string; count: number }[];
  generatedAt: string;
}

export interface AdminConfig {
  eventName: string;
  organiser: string;
  eventDate: string;
  venue: string | null;
  venueConfirmed: boolean;
  registrationOpen: boolean;
  feeAmount: number | null;
  upiPayeeName: string | null;
  upiId: string | null;
  qrImagePath: string | null;
  updatedAt: string;
  missing: string[];
  schools: string[];
  schedules: ExamSchedule[];
}

export interface ExportRow {
  registrationId: string;
  fullName: string;
  schoolName: string;
  rollNumber: string;
  mobile: string;
  classLevel: number;
  shift: number;
  examDate: string;
  examStart: string;
  examEnd: string;
  reportingTime: string;
  createdAt: string;
  paymentStatus: PaymentStatus;
  /** Present only when notes were explicitly requested. */
  paymentNote?: string | null;
  paymentRejectReason?: string | null;
}

export interface ExportResult {
  rows: ExportRow[];
  total: number;
  truncated: boolean;
}

export interface AdmitCard {
  registrationId: string;
  fullName: string;
  schoolName: string;
  rollNumber: string;
  classLevel: number;
  shift: number;
  examDate: string;
  examStart: string;
  examEnd: string;
  reportingTime: string;
  eventName: string;
  organiser: string;
  venue: string;
}
