-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "inApp" BOOLEAN NOT NULL DEFAULT true;


-- Data-integrity rules Prisma cannot express.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_email_status_check" CHECK ("emailStatus" IN ('NONE', 'PENDING', 'SENT', 'FAILED')),
  ADD CONSTRAINT "Notification_email_error_length_check" CHECK ("emailError" IS NULL OR char_length("emailError") <= 200);
